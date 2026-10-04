/**
 * =========================================================
 * FILE: utils/export-queue.js
 * PURPOSE: BOUNDED IN-MEMORY ASYNC EXPORT JOB QUEUE
 * =========================================================
 * এই module export কাজ request-response cycle-এর বাইরে সীমিত concurrency-তে চালানোর process-local queue দেয়।
 * প্রতিটি job UUID, owner/actor identity, lifecycle timestamps, status, result/error এবং expiry ধরে রাখে।
 * Queue capacity overload আটকায়; completed/failed job কিছু সময় download/status-এর জন্য থাকে, তারপর cleanup-এ মুছে যায়।
 */

// ==================== BLOCK 01: UUID DEPENDENCY, DEFAULT LIMITS ও INTEGER PARSER ====================
// Node crypto collision-resistant job id তৈরি করে। Default queue capacity ৮০, একসঙ্গে ১টি job এবং final result retention ১০ মিনিট।
// Positive integer parser option/environment-এর invalid, zero বা negative value-এ safe fallback ব্যবহার করে।
const crypto = require("crypto");

const DEFAULT_MAX_JOBS = 80;
const DEFAULT_CONCURRENCY = 1;
const DEFAULT_TTL_MS = 10 * 60 * 1000;

function readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/*
 * =========================================================
 * BLOCK 02: CONTENT-DISPOSITION থেকে SAFE FILENAME PARSE
 * =========================================================
 * Export response header-এর RFC 5987 `filename*=UTF-8''...` form আগে খোঁজে এবং percent-encoded value decode করে।
 * Encoded form না থাকলে সাধারণ `filename="..."` form নেয়; কোনো match/decode না হলে fallback name ফেরায়।
 * CR, LF ও quote সরিয়ে filename-কে response header/file download ব্যবহারের জন্য নিরাপদ রাখা হয়।
 */
function parseFilenameFromDisposition(disposition, fallback = "export") {
  const value = String(disposition || "");

  // International/encoded filename plain form-এর চেয়ে বেশি নির্ভুল, তাই সেটি priority পায়।
  const encodedMatch = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (encodedMatch) {
    try {
      return decodeURIComponent(encodedMatch[1]).replace(/[\r\n"]/g, "");
    } catch (_error) {
      // Malformed percent encoding decode exception দিলে untrusted raw value না ফিরিয়ে fallback নেওয়া হয়।
      return fallback;
    }
  }

  const plainMatch = value.match(/filename="?([^";]+)"?/i);
  return (plainMatch?.[1] || fallback).replace(/[\r\n"]/g, "");
}

/*
 * =========================================================
 * BLOCK 03: EXPORT QUEUE CLASS ও CONFIGURATION
 * =========================================================
 * Constructor option → environment → default priority-তে capacity, concurrency ও result TTL resolve করে।
 * `jobs` Map id থেকে full job state রাখে, `queue` pending id-এর FIFO order রাখে এবং `activeCount` running slot গোনে।
 * সব data current Node process memory-তে; restart হলে pending/result jobs persist করে না।
 */
class ExportQueue {
  constructor(options = {}) {
    this.maxJobs = readPositiveInt(
      options.maxJobs,
      readPositiveInt(process.env.EXPORT_QUEUE_MAX_JOBS, DEFAULT_MAX_JOBS),
    );
    this.concurrency = readPositiveInt(
      options.concurrency,
      readPositiveInt(
        process.env.EXPORT_QUEUE_CONCURRENCY,
        DEFAULT_CONCURRENCY,
      ),
    );
    this.ttlMs = readPositiveInt(
      options.ttlMs,
      readPositiveInt(process.env.EXPORT_QUEUE_TTL_MS, DEFAULT_TTL_MS),
    );
    this.jobs = new Map();
    this.queue = [];
    this.activeCount = 0;
  }

  /*
   * =========================================================
   * BLOCK 04: ENQUEUE — নতুন EXPORT JOB গ্রহণ
   * =========================================================
   * আগে expired non-running job cleanup করে capacity মাপে; limit পূর্ণ হলে HTTP-friendly status 429 error throw করে।
   * Accepted job-এর immutable identity/request context এবং mutable lifecycle fields তৈরি করে Map/FIFO queue-তে রাখে।
   * Processing loop trigger করার পর caller-কে internal callback/result ছাড়া safe serialized job status ফেরায়।
   */
  enqueue({ ownerId, actorId, requestPath, run }) {
    /* ENQUEUE PHASE A: stale result সরিয়ে actual retained job count অনুযায়ী capacity যাচাই। */
    this.cleanup();

    if (this.jobs.size >= this.maxJobs) {
      const error = new Error(
        "Export queue is busy. Please try again shortly.",
      );
      error.status = 429;
      throw error;
    }

    /* ENQUEUE PHASE B: unique id, tenant/actor context, queued status, timestamps এবং executable callbackসহ job object তৈরি। */
    const now = new Date();
    const job = {
      id: crypto.randomUUID(),
      ownerId: String(ownerId),
      actorId: actorId ? String(actorId) : null,
      requestPath,
      status: "queued",
      createdAt: now,
      startedAt: null,
      completedAt: null,
      expiresAt: new Date(Date.now() + this.ttlMs),
      error: null,
      result: null,
      run,
    };

    /* ENQUEUE PHASE C: job registry ও FIFO pending list-এ যোগ করে available worker slot processing শুরু। */
    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.process();
    return this.serialize(job);
  }

  /*
   * =========================================================
   * BLOCK 05: RAW JOB LOOKUP
   * =========================================================
   * Lookup-এর আগে expired finished jobs সরায়, তারপর normalized id দিয়ে internal full job object অথবা null দেয়।
   * Returned object-এ owner/run/result থাকতে পারে; route middleware-কে ownership যাচাই করে public serializer ব্যবহার করতে হয়।
   */
  get(jobId) {
    this.cleanup();
    const job = this.jobs.get(String(jobId || ""));
    return job || null;
  }

  /*
   * =========================================================
   * BLOCK 06: PUBLIC JOB SERIALIZATION
   * =========================================================
   * Internal callback, owner metadata ও binary/body result বাদ দিয়ে polling client-এর প্রয়োজনীয় lifecycle information তৈরি করে।
   * Optional result থেকে filename/content-type আসে; Date values ISO string হয় এবং not-started/not-completed সময় null থাকে।
   */
  serialize(job) {
    return {
      id: job.id,
      status: job.status,
      request_path: job.requestPath,
      filename: job.result?.filename || null,
      content_type: job.result?.contentType || null,
      created_at: job.createdAt.toISOString(),
      started_at: job.startedAt ? job.startedAt.toISOString() : null,
      completed_at: job.completedAt ? job.completedAt.toISOString() : null,
      expires_at: job.expiresAt.toISOString(),
      error: job.error,
    };
  }

  /*
   * =========================================================
   * BLOCK 07: EXPIRED JOB CLEANUP
   * =========================================================
   * Retention deadline পার হওয়া queued/completed/failed job registry থেকে সরিয়ে deleted count ফেরায়।
   * Running job expiry পার হলেও execution শেষ না হওয়া পর্যন্ত রাখা হয়; completion নতুন full TTL window বসায়।
   * Pending array-তে stale id থাকলে processor পরে Map lookup-এ সেটি skip করে।
   */
  cleanup() {
    const now = Date.now();
    let deleted = 0;
    for (const [jobId, job] of this.jobs.entries()) {
      if (job.expiresAt.getTime() <= now && job.status !== "running") {
        this.jobs.delete(jobId);
        deleted += 1;
      }
    }
    return deleted;
  }

  /*
   * =========================================================
   * BLOCK 08: QUEUE STATISTICS SNAPSHOT
   * =========================================================
   * আগে expired registry entries cleanup করে, তারপর retained jobs status অনুযায়ী count করে।
   * Response-এ registry size, pending-array length, active workers, configuration এবং per-status breakdown থাকে।
   * Operations heartbeat/health dashboard এই lightweight snapshot ব্যবহার করে।
   */
  stats() {
    this.cleanup();
    const byStatus = {};
    for (const job of this.jobs.values()) {
      byStatus[job.status] = (byStatus[job.status] || 0) + 1;
    }

    return {
      jobs: this.jobs.size,
      queued: this.queue.length,
      active: this.activeCount,
      concurrency: this.concurrency,
      max_jobs: this.maxJobs,
      ttl_ms: this.ttlMs,
      by_status: byStatus,
    };
  }

  /*
   * =========================================================
   * BLOCK 09: PROCESSING LOOP ও JOB STATE MACHINE
   * =========================================================
   * যতক্ষণ concurrency slot এবং pending id দুটোই আছে, FIFO queue থেকে job নেয়। Missing/stale/non-queued entry skip হয়।
   * Valid job `queued → running → completed|failed` lifecycle পার করে; promise chain sync/async দুই ধরনের `run` callback support করে।
   * প্রতিটি completion-এর finally active slot ছাড়ে এবং পরবর্তী pending job চালাতে process আবার call করে।
   */
  process() {
    /* PROCESS PHASE A: available worker slot থাকলে FIFO pending id বের করে runnable queued job resolve করা। */
    while (this.activeCount < this.concurrency && this.queue.length) {
      const jobId = this.queue.shift();
      const job = this.jobs.get(jobId);
      if (!job || job.status !== "queued") {
        continue;
      }

      /* PROCESS PHASE B: worker slot reserve, status running এবং start timestamp লেখা। */
      this.activeCount += 1;
      job.status = "running";
      job.startedAt = new Date();

      /* PROCESS PHASE C: Promise boundary-তে callback চালানো, যাতে synchronous return/throw ও async promise একইভাবে handle হয়। */
      Promise.resolve()
        .then(() => job.run())
        .then((result) => {
          // Success-এ result retain, completion time লেখা এবং download/status access-এর জন্য expiry নতুন করে শুরু।
          job.status = "completed";
          job.result = result;
          job.completedAt = new Date();
          job.expiresAt = new Date(Date.now() + this.ttlMs);
        })
        .catch((error) => {
          // Failure-এ safe message retain করে একই TTL window রাখা হয়, যাতে polling client failure reason দেখতে পারে।
          job.status = "failed";
          job.error = error?.message || "Export failed";
          job.completedAt = new Date();
          job.expiresAt = new Date(Date.now() + this.ttlMs);
        })
        .finally(() => {
          // Success/failure উভয় অবস্থায় slot release করে queue-এর পরবর্তী কাজ immediately dispatch করা হয়।
          this.activeCount -= 1;
          this.process();
        });
    }
  }
}

// ==================== BLOCK 10: APPLICATION-WIDE EXPORT QUEUE SINGLETON ====================
// Routes, middleware, background cleanup ও monitoring একই shared queue instance ব্যবহার করে, তাই enqueue/poll/download/status consistent থাকে।
const exportQueue = new ExportQueue();

/*
 * =========================================================
 * BLOCK 11: PUBLIC EXPORT-QUEUE API
 * =========================================================
 * Tests/custom configuration-এর জন্য class, application runtime-এর shared singleton এবং response filename parser export করা হয়।
 * Low-level numeric configuration parser module-private থাকে।
 */
module.exports = {
  ExportQueue,
  exportQueue,
  parseFilenameFromDisposition,
};
