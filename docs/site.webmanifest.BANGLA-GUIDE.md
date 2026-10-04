# `site.webmanifest` — বিস্তারিত বাংলা ব্যাখ্যা

## কেন মূল file-এর মধ্যে comment লেখা হয়নি

`site.webmanifest` একটি JSON document। Standard JSON syntax-এ `// comment` বা `/* comment */`
লেখা যায় না। এমন comment মূল file-এ বসালে browser manifest parse করতে ব্যর্থ হতে পারে। ফলে PWA
installation, app name, standalone display অথবা home-screen icon কাজ না করার ঝুঁকি থাকে। এই guide-এ
মূল manifest-এর প্রতিটি block এবং line-এর কাজ ব্যাখ্যা করা হয়েছে, কিন্তু production JSON অপরিবর্তিত রাখা হয়েছে।

## Block 01: সম্পূর্ণ manifest object

```json
{
  ...
}
```

- প্রথম `{` সম্পূর্ণ web-app manifest object শুরু করে।
- শেষ `}` manifest object শেষ করে।
- মাঝের প্রতিটি key browser-কে installed web app কীভাবে চিহ্নিত, launch ও display করতে হবে তা জানায়।

## Block 02: App identity

```json
"name": "Shop Inventory Management",
"short_name": "Shop Inventory",
```

- `name` হলো application-এর পূর্ণ user-facing নাম। Install prompt, application information অথবা
  operating-system UI-তে পর্যাপ্ত জায়গা থাকলে browser এই নাম ব্যবহার করতে পারে।
- `short_name` কম জায়গার জন্য সংক্ষিপ্ত নাম। Home screen, launcher অথবা compact app list-এ পূর্ণ
  নামের বদলে এটি দেখানো হতে পারে।
- দুইটি value একই product-কে বোঝায়; পার্থক্য শুধু available display space।

## Block 03: Launch URL এবং navigation scope

```json
"start_url": "/",
"scope": "/",
```

- `start_url` installed icon থেকে app চালু করলে browser প্রথমে কোন URL খুলবে তা নির্ধারণ করে। `/`
  ব্যবহার করায় current origin-এর root route launch হয়। Server সেই route থেকে login/dashboard flow ঠিক করে।
- `scope` কোন URL path-গুলো installed web app-এর navigation boundary-এর মধ্যে থাকবে তা জানায়। `/`
  ব্যবহার করায় একই origin-এর সব application path manifest scope-এর মধ্যে পড়ে।
- `start_url` scope-এর ভেতরে আছে; তাই installed app launch boundary consistent থাকে।

## Block 04: Installed app display mode

```json
"display": "standalone",
```

- `standalone` browser-কে installed app-টি সাধারণ browser tab-এর বদলে app-এর মতো window-তে খোলার
  অনুরোধ করে। সাধারণত browser address bar ও tab controls দেখানো হয় না।
- Operating system বা browser support অনুযায়ী final appearance কিছুটা আলাদা হতে পারে।
- এটি fullscreen নয়; system status/navigation areas platform policy অনুযায়ী থাকতে পারে।

## Block 05: Startup এবং browser theme colors

```json
"background_color": "#17324a",
"theme_color": "#17324a",
```

- `background_color` installed app load হওয়ার সময় page content প্রস্তুত হওয়ার আগে splash/startup surface-এ
  ব্যবহার হতে পারে। Dark navy value brand background-এর সঙ্গে visual continuity রাখে।
- `theme_color` supported browser/operating-system UI—যেমন title bar বা status area—এর theme hint দেয়।
- একই color দুই জায়গায় রাখায় startup এবং surrounding system chrome-এর মধ্যে আকস্মিক color পরিবর্তন কমে।

## Block 06: App icon collection

```json
"icons": [
  {
    "src": "/images/app_logo.png?v=2026-07-03-shop-brand-logo-1",
    "sizes": "512x512",
    "type": "image/png",
    "purpose": "any"
  }
]
```

- `icons` একটি array, কারণ manifest একাধিক size/purpose-এর icon রাখতে পারে। বর্তমানে একটি icon resource আছে।
- `src` icon file-এর root-relative URL। Query version browser/CDN cache refresh করতে সাহায্য করে যখন brand
  asset update করা হয়।
- `sizes: "512x512"` browser-কে source image-এর declared pixel dimensions জানায়। এটি install prompt,
  launcher icon অথবা generated app surfaces-এর জন্য বড় master icon হিসেবে ব্যবহৃত হতে পারে।
- `type: "image/png"` resource-এর MIME type ঘোষণা করে, যাতে browser download করার আগেই format বুঝতে পারে।
- `purpose: "any"` icon-টি general-purpose display-এর জন্য। Browser প্রয়োজন অনুযায়ী icon scale বা shape
  করতে পারে। এটি `maskable` safe-zone icon হিসেবে ঘোষণা করা হয়নি।
- Array-এর `]` icon collection শেষ করে; inner `}` একক icon object শেষ করে।

## Browser-এর ব্যবহারধারা

1. HTML-এর `<link rel="manifest" href="/site.webmanifest">` browser-কে এই file-এর location জানায়।
2. Browser JSON parse করে app identity, launch settings, colors ও icons পড়ে।
3. PWA install eligibility-এর অন্য শর্ত পূরণ হলে browser install UI দেখাতে পারে।
4. Installed icon চালু হলে browser `/` URL-কে `/` scope-এর মধ্যে `standalone` mode-এ খোলে।
5. Startup ও operating-system surfaces-এ declared navy color এবং PNG icon ব্যবহার হতে পারে।

## পরিবর্তনের সময় সতর্কতা

- Property name ও string value সবসময় double quote-এর মধ্যে রাখতে হবে।
- শেষ property-এর পরে trailing comma যোগ করা যাবে না; strict JSON parser সেটি reject করতে পারে।
- `start_url` বদলালে নতুন URL অবশ্যই intended `scope`-এর মধ্যে রাখা উচিত।
- Icon বদলালে actual image dimensions, `sizes`, MIME `type` এবং cache-version query একসঙ্গে যাচাই করা উচিত।
- `purpose: "maskable"` যোগ করার আগে icon artwork maskable safe zone অনুসরণ করছে কি না নিশ্চিত করতে হবে।
