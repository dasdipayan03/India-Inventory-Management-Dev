# তিনটি JSON file-এর line-by-line বাংলা guide

এই document-এ project root-এর নিচের তিনটি file ব্যাখ্যা করা হয়েছে:

1. `package.json`
2. `package-lock.json`
3. `railway.json`

Line number বর্তমান file version অনুযায়ী লেখা। File regenerate বা dependency update হলে বিশেষ করে `package-lock.json`-এর line number বদলাতে পারে।

## JSON পড়ার প্রাথমিক নিয়ম

| চিহ্ন | কাজ |
|---|---|
| `{ ... }` | একটি object শুরু ও শেষ করে। Object-এর ভিতরে key-value pair থাকে। |
| `"key": value` | বাম পাশে property name এবং ডান পাশে তার value। |
| `[ ... ]` | একটি array বা ordered list। এই তিন file-এ top-level array নেই। |
| `,` | একই object-এর পরের property এখনও আছে বোঝায়। শেষ property-এর পরে comma থাকে না। |
| `"text"` | String value। JSON-এ property name-ও double quote-এর মধ্যে থাকে। |
| `true` / `false` | Boolean value। এগুলো string নয়, তাই quote থাকে না। |
| Number | Numeric value; যেমন Railway timeout `120`। |

JSON file-এ JavaScript-style comment লেখা যায় না। এই কারণে ব্যাখ্যাগুলো আলাদা Markdown document-এ রাখা হয়েছে।

---

## 1. `package.json` — line-by-line

এই file project-এর human-edited npm manifest। Project name, start command, Node requirement এবং direct dependencies এখানে থাকে।

| Line | Code/field | কাজ |
|---:|---|---|
| 1 | `{` | Root JSON object শুরু করে। |
| 2 | `"name": "shop-inventory-management"` | npm project/package-এর machine-readable নাম। Logs, package metadata এবং npm tooling এই নাম ব্যবহার করতে পারে। |
| 3 | `"version": "1.0.0"` | Semantic version: major `1`, minor `0`, patch `0`। Application release metadata হিসেবে ব্যবহৃত হয়। |
| 4 | `"main": "server.js"` | Package entry module `server.js` নির্দেশ করে। অন্য Node module এই package require করলে এটি default entry হয়। |
| 5 | `"scripts": {` | npm command alias-এর object শুরু করে। |
| 6 | `"start": "node --max-old-space-size=256 server.js"` | `npm start` চালালে Node সর্বোচ্চ প্রায় 256 MB old-generation heap limit দিয়ে `server.js` চালায়। Railway-তেও একই command আছে। |
| 7 | `},` | `scripts` object শেষ; root object-এ আরও fields আছে বলে comma রয়েছে। |
| 8 | `"engines": {` | Supported runtime versions-এর declaration শুরু করে। Hosting/npm compatibility check এটি পড়তে পারে। |
| 9 | `"node": ">=18.0.0"` | Node.js 18.0.0 বা তার পরের version প্রয়োজন। `>=` মানে 18 সহ newer major versions-ও range-এর মধ্যে। |
| 10 | `},` | `engines` object শেষ। |
| 11 | `"dependencies": {` | Production runtime-এর direct npm packages শুরু। `npm install --omit=dev`-এ এগুলো install হয়। |
| 12 | `"bcrypt": "^6.0.0"` | Password hash/compare করে। Caret range major 6-এর মধ্যে compatible newer minor/patch অনুমতি দেয়। |
| 13 | `"compression": "^1.8.1"` | Express response gzip/deflate compression middleware। |
| 14 | `"cookie-parser": "^1.4.7"` | Incoming Cookie header parse করে `req.cookies` তৈরি করে। |
| 15 | `"cors": "^2.8.5"` | Cross-Origin Resource Sharing policy middleware। Allowed browser origins ও credentials নিয়ন্ত্রণ করে। |
| 16 | `"exceljs": "^4.4.0"` | Excel workbook/worksheet তৈরি ও export করে। |
| 17 | `"express": "^4.22.2"` | HTTP server, middleware pipeline এবং API/static routes-এর web framework। |
| 18 | `"express-rate-limit": "^8.6.2"` | নির্দিষ্ট সময়ের মধ্যে request সংখ্যা সীমিত করে abuse/overload কমায়। |
| 19 | `"helmet": "^7.2.0"` | CSP, frame guard, no-sniff, referrer policy-সহ HTTP security headers বসায়। |
| 20 | `"jsonwebtoken": "^9.0.2"` | JWT session/state token sign এবং verify করে। |
| 21 | `"pdfkit": "^0.17.2"` | Invoice ও report PDF programmatically তৈরি করে। |
| 22 | `"pg": "^8.11.3"` | PostgreSQL driver ও connection pool দেয়। Lockfile বর্তমানে compatible `8.16.3` install pin করেছে। |
| 23 | `}` | `dependencies` object শেষ। Last root property বলে comma নেই। |
| 24 | `}` | Root JSON object শেষ; `package.json` সম্পূর্ণ। |

### Caret (`^`) version-এর মানে

`^8.11.3` সাধারণত `8.11.3` থেকে শুরু করে `9.0.0`-এর আগের compatible version নিতে দেয়। `package.json` range বলে; `package-lock.json` ঠিক কোন version install হবে সেটি pin করে।

---

## 2. `railway.json` — line-by-line

এই file Railway deployment platform-কে build-এর পরে application কীভাবে start ও monitor করতে হবে তা বলে।

| Line | Code/field | কাজ |
|---:|---|---|
| 1 | `{` | Railway configuration-এর root object শুরু। |
| 2 | `"$schema": "https://railway.com/railway.schema.json"` | Editor/validator-কে Railway JSON schema দেয়; autocomplete ও invalid field detection-এ সাহায্য করে। Runtime application এই URL fetch করে না। |
| 3 | `"deploy": {` | Deployment/runtime settings object শুরু। |
| 4 | `"startCommand": "node --max-old-space-size=256 server.js"` | Railway container application start করতে এই exact shell command চালায়। npm script-এর মতো Node heap limit 256 MB রাখা হয়েছে। |
| 5 | `"healthcheckPath": "/health"` | Deploy successful/ready কি না জানতে Railway `/health` endpoint request করে। Server readiness response DB ready না হলে 503 দেয়। |
| 6 | `"healthcheckTimeout": 120` | Health check সফল হওয়ার জন্য সর্বোচ্চ 120 seconds অপেক্ষা করতে পারে। Slow cold start/migration-এর সময় এটি কাজে লাগে। |
| 7 | `"restartPolicyType": "ON_FAILURE"` | Process non-zero failure-এ থামলে Railway restart চেষ্টা করবে; clean intentional exit একই policy-তে failure নয়। |
| 8 | `"restartPolicyMaxRetries": 10` | Failure-এর পরে সর্বোচ্চ 10টি restart attempt অনুমোদিত। Persistent configuration error-এ endless restart কমায়। |
| 9 | `}` | `deploy` object শেষ। |
| 10 | `}` | Railway root object শেষ। |

---

## 3. `package-lock.json` — কীভাবে line-by-line পড়তে হবে

এই file npm নিজে generate করে। হাতে edit করা উচিত নয়। `npm install` dependency tree resolve করার পরে exact versions, download URL এবং integrity hash এখানে lock করে। বর্তমান file-এ 2,429 line এবং project root-সহ 229টি package record আছে।

### Lines 1–26: root metadata ও direct dependencies

| Line | Code/field | কাজ |
|---:|---|---|
| 1 | `{` | সম্পূর্ণ lockfile root object শুরু। |
| 2 | `name` | `package.json`-এর project name mirror করে। |
| 3 | `version` | Root project version mirror করে। |
| 4 | `lockfileVersion: 3` | Modern npm lockfile v3 format। এটি `packages` location map ব্যবহার করে এবং npm 7+ ecosystem-এর জন্য তৈরি। |
| 5 | `requires: true` | এই project dependency resolution ব্যবহার করে এবং dependency metadata lockfile-এ রাখা হয়েছে। |
| 6 | `packages: {` | Installed location থেকে package metadata map শুরু। Key `node_modules/...` path বোঝায়। |
| 7 | `"": {` | Empty path root project নিজেকে বোঝায়; এটি `node_modules` package নয়। |
| 8 | root `name` | Root manifest name mirror। |
| 9 | root `version` | Root manifest version mirror। |
| 10 | root `dependencies: {` | Project-এর direct dependency ranges শুরু। |
| 11–21 | 11 direct dependencies | `package.json` lines 12–22-এর একই names/ranges lockfile root record-এ mirror করা হয়েছে। |
| 22 | `}` | Root dependency range object শেষ। |
| 23 | root `engines: {` | Root Node runtime requirement শুরু। |
| 24 | `node: ">=18.0.0"` | `package.json`-এর Node requirement mirror। |
| 25 | `}` | Root engines object শেষ। |
| 26 | `}` | Root package record শেষ; line 27 থেকে installed packages শুরু। |

### প্রতিটি repeated package record-এর field

| Field | প্রতিটি occurrence-এর অর্থ |
|---|---|
| `"node_modules/<name>": {` | Package install location এবং record শুরু। Nested path যেমন `express/node_modules/debug` মানে parent package-এর জন্য আলাদা version বসেছে। |
| `version` | Exact installed version। এখানে range নয়; reproducible install-এর pin। |
| `resolved` | npm registry tarball URL যেখান থেকে package download হবে। |
| `integrity` | সাধারণত SHA-512 Subresource Integrity hash। Download corrupt/tampered হলে npm install reject করে। |
| `license` | Package author ঘোষিত software license metadata। |
| `dependencies` | ওই package চালাতে আরও যেসব packages ও version ranges দরকার। এই nested lines dependency graph-এর edge। |
| `engines` | Package কোন Node/npm version support করে তার declaration। |
| `funding` | Maintainer sponsorship/donation metadata; runtime behavior বদলায় না। |
| `bin` | Package কোন executable command expose করে তার mapping। |
| `hasInstallScript` | Install-এর সময় package script/native setup চালাতে পারে। বর্তমান lockfile-এ bcrypt record-এ আছে। |
| `peerDependencies` | Host/application বা sibling package থেকে compatible dependency প্রত্যাশা করে। |
| `peerDependenciesMeta` | Peer dependency optional ইত্যাদি অতিরিক্ত rule। |
| `optionalDependencies` | Install ব্যর্থ হলেও package কখনও fallback-সহ চলতে পারে এমন dependency। |
| `optional: true` | পুরো package optional resolution হিসেবে এসেছে। |
| `deprecated` | Package/version maintainer deprecated করেছে; install tree-তে এখনও transitive requirement হিসেবে থাকতে পারে। |
| Closing `}` / `},` | Current nested object/record শেষ। পরের sibling থাকলে comma থাকে। |

### Direct dependencyগুলোর project-এ কাজ

| Direct package | Locked version | Project-এ কাজ |
|---|---:|---|
| `bcrypt` | 6.0.0 | User/developer password hashing ও verification। |
| `compression` | 1.8.1 | বড় HTTP response compress করে bandwidth কমায়। |
| `cookie-parser` | 1.4.7 | Session cookie parse করে। |
| `cors` | 2.8.5 | Browser cross-origin request policy enforce করে। |
| `exceljs` | 4.4.0 | Inventory/sales/GST Excel exports তৈরি করে। |
| `express` | 4.22.2 | API ও frontend HTTP server framework। |
| `express-rate-limit` | 8.6.2 | Request quota/rate limit। |
| `helmet` | 7.2.0 | Browser security headers ও CSP। |
| `jsonwebtoken` | 9.0.2 | Session/OAuth-related JWT sign/verify। |
| `pdfkit` | 0.17.2 | Invoice/report PDF generation। |
| `pg` | 8.16.3 | PostgreSQL queries ও pool। `package.json` minimum range `^8.11.3`, lockfile exact compatible version `8.16.3` বেছে নিয়েছে। |

### সব package record-এর source-line inventory

`Role`-এ **Direct** মানে `package.json`-এ সরাসরি লেখা, **Transitive** মানে অন্য package-এর প্রয়োজন, এবং **Root** মানে project record। `Extra fields` column-এ `version/resolved/integrity/license` ছাড়া record-এ থাকা property দেখানো হয়েছে। ওই range-এর ভেতরের প্রতিটি line উপরের repeated-field table-এর rule অনুসরণ করে।

| Lines | Package/location | Exact version | Role | Extra fields |
|---:|---|---:|---|---|
| 7-26 | `(project root)` | `1.0.0` | Root | name, dependencies, engines |
| 27-40 | `@fast-csv/format` | `4.3.5` | Transitive | dependencies |
| 41-55 | `@fast-csv/parse` | `4.3.6` | Transitive | dependencies |
| 56-64 | `@swc/helpers` | `0.5.17` | Transitive | dependencies |
| 65-70 | `@types/node` | `14.18.63` | Transitive | - |
| 71-83 | `accepts` | `1.3.8` | Transitive | dependencies, engines |
| 84-101 | `archiver` | `5.3.2` | Transitive | dependencies, engines |
| 102-122 | `archiver-utils` | `2.1.0` | Transitive | dependencies, engines |
| 123-137 | `archiver-utils/node_modules/readable-stream` | `2.3.8` | Transitive | dependencies |
| 138-143 | `archiver-utils/node_modules/safe-buffer` | `5.1.2` | Transitive | - |
| 144-152 | `archiver-utils/node_modules/string_decoder` | `1.1.1` | Transitive | dependencies |
| 153-158 | `array-flatten` | `1.1.1` | Transitive | - |
| 159-164 | `async` | `3.2.6` | Transitive | - |
| 165-170 | `balanced-match` | `1.0.2` | Transitive | - |
| 171-190 | `base64-js` | `1.5.1` | Transitive | funding |
| 191-204 | `bcrypt` | `6.0.0` | Direct | hasInstallScript, dependencies, engines |
| 205-213 | `big-integer` | `1.6.52` | Transitive | engines |
| 214-226 | `binary` | `0.3.0` | Transitive | dependencies, engines |
| 227-237 | `bl` | `4.1.0` | Transitive | dependencies |
| 238-243 | `bluebird` | `3.4.7` | Transitive | - |
| 244-267 | `body-parser` | `1.20.6` | Transitive | dependencies, engines |
| 268-276 | `body-parser/node_modules/debug` | `2.6.9` | Transitive | dependencies |
| 277-282 | `body-parser/node_modules/ms` | `2.0.0` | Transitive | - |
| 283-292 | `brace-expansion` | `1.1.18` | Transitive | dependencies |
| 293-301 | `brotli` | `1.3.3` | Transitive | dependencies |
| 302-325 | `buffer` | `5.7.1` | Transitive | funding, dependencies |
| 326-334 | `buffer-crc32` | `0.2.13` | Transitive | engines |
| 335-340 | `buffer-equal-constant-time` | `1.0.1` | Transitive | - |
| 341-349 | `buffer-indexof-polyfill` | `1.0.2` | Transitive | engines |
| 350-357 | `buffers` | `0.1.1` | Transitive | engines |
| 358-366 | `bytes` | `3.1.2` | Transitive | engines |
| 367-379 | `call-bind-apply-helpers` | `1.0.2` | Transitive | dependencies, engines |
| 380-395 | `call-bound` | `1.0.4` | Transitive | dependencies, engines, funding |
| 396-407 | `chainsaw` | `0.1.0` | Transitive | dependencies, engines |
| 408-416 | `clone` | `2.1.2` | Transitive | engines |
| 417-431 | `compress-commons` | `4.1.2` | Transitive | dependencies, engines |
| 432-443 | `compressible` | `2.0.18` | Transitive | dependencies, engines |
| 444-461 | `compression` | `1.8.1` | Direct | dependencies, engines |
| 462-470 | `compression/node_modules/debug` | `2.6.9` | Transitive | dependencies |
| 471-476 | `compression/node_modules/ms` | `2.0.0` | Transitive | - |
| 477-485 | `compression/node_modules/negotiator` | `0.6.4` | Transitive | engines |
| 486-491 | `concat-map` | `0.0.1` | Transitive | - |
| 492-503 | `content-disposition` | `0.5.4` | Transitive | dependencies, engines |
| 504-512 | `content-type` | `1.0.5` | Transitive | engines |
| 513-521 | `cookie` | `0.7.2` | Transitive | engines |
| 522-534 | `cookie-parser` | `1.4.7` | Direct | dependencies, engines |
| 535-540 | `cookie-signature` | `1.0.6` | Transitive | - |
| 541-546 | `core-util-is` | `1.0.3` | Transitive | - |
| 547-559 | `cors` | `2.8.5` | Direct | dependencies, engines |
| 560-571 | `crc-32` | `1.2.2` | Transitive | bin, engines |
| 572-584 | `crc32-stream` | `4.0.3` | Transitive | dependencies, engines |
| 585-590 | `crypto-js` | `4.2.0` | Transitive | - |
| 591-596 | `dayjs` | `1.11.18` | Transitive | - |
| 597-613 | `debug` | `4.4.3` | Transitive | dependencies, engines, peerDependenciesMeta |
| 614-622 | `depd` | `2.0.0` | Transitive | engines |
| 623-632 | `destroy` | `1.2.0` | Transitive | engines |
| 633-638 | `dfa` | `1.2.0` | Transitive | - |
| 639-652 | `dunder-proto` | `1.0.1` | Transitive | dependencies, engines |
| 653-661 | `duplexer2` | `0.1.4` | Transitive | dependencies |
| 662-676 | `duplexer2/node_modules/readable-stream` | `2.3.8` | Transitive | dependencies |
| 677-682 | `duplexer2/node_modules/safe-buffer` | `5.1.2` | Transitive | - |
| 683-691 | `duplexer2/node_modules/string_decoder` | `1.1.1` | Transitive | dependencies |
| 692-700 | `ecdsa-sig-formatter` | `1.0.11` | Transitive | dependencies |
| 701-706 | `ee-first` | `1.1.1` | Transitive | - |
| 707-715 | `encodeurl` | `2.0.0` | Transitive | engines |
| 716-724 | `end-of-stream` | `1.4.5` | Transitive | dependencies |
| 725-733 | `es-define-property` | `1.0.1` | Transitive | engines |
| 734-742 | `es-errors` | `1.3.0` | Transitive | engines |
| 743-754 | `es-object-atoms` | `1.1.2` | Transitive | dependencies, engines |
| 755-760 | `escape-html` | `1.0.3` | Transitive | - |
| 761-769 | `etag` | `1.8.1` | Transitive | engines |
| 770-789 | `exceljs` | `4.4.0` | Direct | dependencies, engines |
| 790-835 | `express` | `4.22.2` | Direct | dependencies, engines, funding |
| 836-854 | `express-rate-limit` | `8.6.2` | Direct | dependencies, engines, funding, peerDependencies |
| 855-863 | `express/node_modules/debug` | `2.6.9` | Transitive | dependencies |
| 864-869 | `express/node_modules/ms` | `2.0.0` | Transitive | - |
| 870-882 | `fast-csv` | `4.3.6` | Transitive | dependencies, engines |
| 883-888 | `fast-deep-equal` | `3.1.3` | Transitive | - |
| 889-906 | `finalhandler` | `1.3.2` | Transitive | dependencies, engines |
| 907-915 | `finalhandler/node_modules/debug` | `2.6.9` | Transitive | dependencies |
| 916-921 | `finalhandler/node_modules/ms` | `2.0.0` | Transitive | - |
| 922-938 | `fontkit` | `2.0.4` | Transitive | dependencies |
| 939-947 | `forwarded` | `0.2.0` | Transitive | engines |
| 948-956 | `fresh` | `0.5.2` | Transitive | engines |
| 957-962 | `fs-constants` | `1.0.0` | Transitive | - |
| 963-968 | `fs.realpath` | `1.0.0` | Transitive | - |
| 969-984 | `fstream` | `1.0.12` | Transitive | deprecated, dependencies, engines |
| 985-996 | `fstream/node_modules/mkdirp` | `0.5.6` | Transitive | dependencies, bin |
| 997-1009 | `fstream/node_modules/rimraf` | `2.7.1` | Transitive | deprecated, dependencies, bin |
| 1010-1018 | `function-bind` | `1.1.2` | Transitive | funding |
| 1019-1042 | `get-intrinsic` | `1.3.0` | Transitive | dependencies, engines, funding |
| 1043-1055 | `get-proto` | `1.0.1` | Transitive | dependencies, engines |
| 1056-1076 | `glob` | `7.2.3` | Transitive | deprecated, dependencies, engines, funding |
| 1077-1088 | `gopd` | `1.2.0` | Transitive | engines, funding |
| 1089-1094 | `graceful-fs` | `4.2.11` | Transitive | - |
| 1095-1106 | `has-symbols` | `1.1.0` | Transitive | engines, funding |
| 1107-1118 | `hasown` | `2.0.4` | Transitive | dependencies, engines |
| 1119-1127 | `helmet` | `7.2.0` | Direct | engines |
| 1128-1147 | `http-errors` | `2.0.1` | Transitive | dependencies, engines, funding |
| 1148-1159 | `iconv-lite` | `0.4.24` | Transitive | dependencies, engines |
| 1160-1179 | `ieee754` | `1.2.1` | Transitive | funding |
| 1180-1185 | `immediate` | `3.0.6` | Transitive | - |
| 1186-1196 | `inflight` | `1.0.6` | Transitive | deprecated, dependencies |
| 1197-1202 | `inherits` | `2.0.4` | Transitive | - |
| 1203-1211 | `ip-address` | `10.5.0` | Transitive | engines |
| 1212-1220 | `ipaddr.js` | `1.9.1` | Transitive | engines |
| 1221-1226 | `isarray` | `1.0.0` | Transitive | - |
| 1227-1232 | `jpeg-exif` | `1.1.4` | Transitive | - |
| 1233-1254 | `jsonwebtoken` | `9.0.2` | Direct | dependencies, engines |
| 1255-1266 | `jszip` | `3.10.1` | Transitive | dependencies |
| 1267-1281 | `jszip/node_modules/readable-stream` | `2.3.8` | Transitive | dependencies |
| 1282-1287 | `jszip/node_modules/safe-buffer` | `5.1.2` | Transitive | - |
| 1288-1296 | `jszip/node_modules/string_decoder` | `1.1.1` | Transitive | dependencies |
| 1297-1307 | `jwa` | `1.4.2` | Transitive | dependencies |
| 1308-1317 | `jws` | `3.2.3` | Transitive | dependencies |
| 1318-1329 | `lazystream` | `1.0.1` | Transitive | dependencies, engines |
| 1330-1344 | `lazystream/node_modules/readable-stream` | `2.3.8` | Transitive | dependencies |
| 1345-1350 | `lazystream/node_modules/safe-buffer` | `5.1.2` | Transitive | - |
| 1351-1359 | `lazystream/node_modules/string_decoder` | `1.1.1` | Transitive | dependencies |
| 1360-1368 | `lie` | `3.3.0` | Transitive | dependencies |
| 1369-1378 | `linebreak` | `1.1.0` | Transitive | dependencies |
| 1379-1387 | `linebreak/node_modules/base64-js` | `0.0.8` | Transitive | engines |
| 1388-1393 | `listenercount` | `1.0.1` | Transitive | - |
| 1394-1399 | `lodash.defaults` | `4.2.0` | Transitive | - |
| 1400-1405 | `lodash.difference` | `4.5.0` | Transitive | - |
| 1406-1411 | `lodash.escaperegexp` | `4.1.2` | Transitive | - |
| 1412-1417 | `lodash.flatten` | `4.4.0` | Transitive | - |
| 1418-1423 | `lodash.groupby` | `4.6.0` | Transitive | - |
| 1424-1429 | `lodash.includes` | `4.3.0` | Transitive | - |
| 1430-1435 | `lodash.isboolean` | `3.0.3` | Transitive | - |
| 1436-1442 | `lodash.isequal` | `4.5.0` | Transitive | deprecated |
| 1443-1448 | `lodash.isfunction` | `3.0.9` | Transitive | - |
| 1449-1454 | `lodash.isinteger` | `4.0.4` | Transitive | - |
| 1455-1460 | `lodash.isnil` | `4.0.0` | Transitive | - |
| 1461-1466 | `lodash.isnumber` | `3.0.3` | Transitive | - |
| 1467-1472 | `lodash.isplainobject` | `4.0.6` | Transitive | - |
| 1473-1478 | `lodash.isstring` | `4.0.1` | Transitive | - |
| 1479-1484 | `lodash.isundefined` | `3.0.1` | Transitive | - |
| 1485-1490 | `lodash.once` | `4.1.1` | Transitive | - |
| 1491-1496 | `lodash.union` | `4.6.0` | Transitive | - |
| 1497-1502 | `lodash.uniq` | `4.5.0` | Transitive | - |
| 1503-1511 | `math-intrinsics` | `1.1.0` | Transitive | engines |
| 1512-1520 | `media-typer` | `0.3.0` | Transitive | engines |
| 1521-1529 | `merge-descriptors` | `1.0.3` | Transitive | funding |
| 1530-1538 | `methods` | `1.1.2` | Transitive | engines |
| 1539-1550 | `mime` | `1.6.0` | Transitive | bin, engines |
| 1551-1559 | `mime-db` | `1.52.0` | Transitive | engines |
| 1560-1571 | `mime-types` | `2.1.35` | Transitive | dependencies, engines |
| 1572-1583 | `minimatch` | `3.1.5` | Transitive | dependencies, engines |
| 1584-1592 | `minimist` | `1.2.8` | Transitive | funding |
| 1593-1598 | `ms` | `2.1.3` | Transitive | - |
| 1599-1607 | `negotiator` | `0.6.3` | Transitive | engines |
| 1608-1616 | `node-addon-api` | `8.9.2` | Transitive | engines |
| 1617-1627 | `node-gyp-build` | `4.8.4` | Transitive | bin |
| 1628-1636 | `normalize-path` | `3.0.0` | Transitive | engines |
| 1637-1645 | `object-assign` | `4.1.1` | Transitive | engines |
| 1646-1657 | `object-inspect` | `1.13.4` | Transitive | engines, funding |
| 1658-1669 | `on-finished` | `2.4.1` | Transitive | dependencies, engines |
| 1670-1678 | `on-headers` | `1.1.0` | Transitive | engines |
| 1679-1687 | `once` | `1.4.0` | Transitive | dependencies |
| 1688-1693 | `pako` | `1.0.11` | Transitive | - |
| 1694-1702 | `parseurl` | `1.3.3` | Transitive | engines |
| 1703-1711 | `path-is-absolute` | `1.0.1` | Transitive | engines |
| 1712-1717 | `path-to-regexp` | `0.1.13` | Transitive | - |
| 1718-1730 | `pdfkit` | `0.17.2` | Direct | dependencies |
| 1731-1757 | `pg` | `8.16.3` | Direct | dependencies, engines, optionalDependencies, peerDependencies, peerDependenciesMeta |
| 1758-1764 | `pg-cloudflare` | `1.2.7` | Transitive | optional |
| 1765-1770 | `pg-connection-string` | `2.9.1` | Transitive | - |
| 1771-1779 | `pg-int8` | `1.0.1` | Transitive | engines |
| 1780-1788 | `pg-pool` | `3.10.1` | Transitive | peerDependencies |
| 1789-1794 | `pg-protocol` | `1.10.3` | Transitive | - |
| 1795-1810 | `pg-types` | `2.2.0` | Transitive | dependencies, engines |
| 1811-1819 | `pgpass` | `1.0.5` | Transitive | dependencies |
| 1820-1824 | `png-js` | `1.0.0` | Transitive | - |
| 1825-1833 | `postgres-array` | `2.0.0` | Transitive | engines |
| 1834-1842 | `postgres-bytea` | `1.0.0` | Transitive | engines |
| 1843-1851 | `postgres-date` | `1.0.7` | Transitive | engines |
| 1852-1863 | `postgres-interval` | `1.2.0` | Transitive | dependencies, engines |
| 1864-1869 | `process-nextick-args` | `2.0.1` | Transitive | - |
| 1870-1882 | `proxy-addr` | `2.0.7` | Transitive | dependencies, engines |
| 1883-1898 | `qs` | `6.15.3` | Transitive | dependencies, engines, funding |
| 1899-1907 | `range-parser` | `1.2.1` | Transitive | engines |
| 1908-1922 | `raw-body` | `2.5.3` | Transitive | dependencies, engines |
| 1923-1936 | `readable-stream` | `3.6.2` | Transitive | dependencies, engines |
| 1937-1945 | `readdir-glob` | `1.1.3` | Transitive | dependencies |
| 1946-1954 | `readdir-glob/node_modules/brace-expansion` | `2.1.4` | Transitive | dependencies |
| 1955-1966 | `readdir-glob/node_modules/minimatch` | `5.1.9` | Transitive | dependencies, engines |
| 1967-1972 | `restructure` | `3.0.2` | Transitive | - |
| 1973-1992 | `safe-buffer` | `5.2.1` | Transitive | funding |
| 1993-1998 | `safer-buffer` | `2.1.2` | Transitive | - |
| 1999-2010 | `saxes` | `5.0.1` | Transitive | dependencies, engines |
| 2011-2022 | `semver` | `7.7.2` | Transitive | bin, engines |
| 2023-2046 | `send` | `0.19.2` | Transitive | dependencies, engines |
| 2047-2055 | `send/node_modules/debug` | `2.6.9` | Transitive | dependencies |
| 2056-2061 | `send/node_modules/debug/node_modules/ms` | `2.0.0` | Transitive | - |
| 2062-2076 | `serve-static` | `1.16.3` | Transitive | dependencies, engines |
| 2077-2082 | `setimmediate` | `1.0.5` | Transitive | - |
| 2083-2088 | `setprototypeof` | `1.2.0` | Transitive | - |
| 2089-2107 | `side-channel` | `1.1.1` | Transitive | dependencies, engines, funding |
| 2108-2123 | `side-channel-list` | `1.0.1` | Transitive | dependencies, engines, funding |
| 2124-2141 | `side-channel-map` | `1.0.1` | Transitive | dependencies, engines, funding |
| 2142-2160 | `side-channel-weakmap` | `1.0.2` | Transitive | dependencies, engines, funding |
| 2161-2169 | `split2` | `4.2.0` | Transitive | engines |
| 2170-2178 | `statuses` | `2.0.2` | Transitive | engines |
| 2179-2187 | `string_decoder` | `1.3.0` | Transitive | dependencies |
| 2188-2203 | `tar-stream` | `2.2.0` | Transitive | dependencies, engines |
| 2204-2209 | `tiny-inflate` | `1.0.3` | Transitive | - |
| 2210-2218 | `tmp` | `0.2.7` | Transitive | engines |
| 2219-2227 | `toidentifier` | `1.0.1` | Transitive | engines |
| 2228-2236 | `traverse` | `0.3.9` | Transitive | engines |
| 2237-2242 | `tslib` | `2.8.1` | Transitive | - |
| 2243-2255 | `type-is` | `1.6.18` | Transitive | dependencies, engines |
| 2256-2265 | `unicode-properties` | `1.4.1` | Transitive | dependencies |
| 2266-2275 | `unicode-trie` | `2.0.0` | Transitive | dependencies |
| 2276-2281 | `unicode-trie/node_modules/pako` | `0.2.9` | Transitive | - |
| 2282-2290 | `unpipe` | `1.0.0` | Transitive | engines |
| 2291-2308 | `unzipper` | `0.10.14` | Transitive | dependencies |
| 2309-2323 | `unzipper/node_modules/readable-stream` | `2.3.8` | Transitive | dependencies |
| 2324-2329 | `unzipper/node_modules/safe-buffer` | `5.1.2` | Transitive | - |
| 2330-2338 | `unzipper/node_modules/string_decoder` | `1.1.1` | Transitive | dependencies |
| 2339-2344 | `util-deprecate` | `1.0.2` | Transitive | - |
| 2345-2353 | `utils-merge` | `1.0.1` | Transitive | engines |
| 2354-2362 | `uuid` | `8.3.2` | Transitive | bin |
| 2363-2371 | `vary` | `1.1.2` | Transitive | engines |
| 2372-2377 | `wrappy` | `1.0.2` | Transitive | - |
| 2378-2383 | `xmlchars` | `2.2.0` | Transitive | - |
| 2384-2392 | `xtend` | `4.0.2` | Transitive | engines |
| 2393-2406 | `zip-stream` | `4.1.1` | Transitive | dependencies, engines |
| 2407-2427 | `zip-stream/node_modules/archiver-utils` | `3.0.4` | Transitive | dependencies, engines |

### শেষ দুই line

| Line | কাজ |
|---:|---|
| 2428 | `packages` object শেষ করে। |
| 2429 | সম্পূর্ণ lockfile root object শেষ করে। |

## কোন file কে edit করবে?

| File | হাতে edit করা যাবে? | কখন বদলাবে? |
|---|---|---|
| `package.json` | হ্যাঁ | Script, supported Node version বা direct dependency যোগ/বদলালে। |
| `package-lock.json` | সাধারণত না | `npm install`, `npm update` বা dependency change-এর পরে npm regenerate করবে। এটি Git-এ commit করতে হবে। |
| `railway.json` | হ্যাঁ | Railway start command, health check বা restart policy বদলালে। |

## তিনটি file একসঙ্গে কীভাবে কাজ করে

1. Railway `railway.json` পড়ে start command ও health policy জানে।
2. Node/npm `package.json` পড়ে project command ও direct dependency ranges জানে।
3. npm `package-lock.json` পড়ে exact dependency tree এবং verified tarball install করে।
4. Railway start command `server.js` চালায়।
5. Railway `/health` call করে application ও database ready কি না যাচাই করে।
