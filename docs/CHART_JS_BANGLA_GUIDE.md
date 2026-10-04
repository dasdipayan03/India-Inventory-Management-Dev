# Chart.js বাংলা গাইড

`public/js/chart.min.js` হলো Chart.js v4.5.1-এর minified third-party library। Dashboard নিজে chart আঁকার নিয়ম লেখে না; সে এই library-কে data ও options দেয়।

পড়ার নিয়ম: business logic বোঝার জন্য [dashboard.js](../public/js/dashboard.js) দেখো। সেখানে `ensureChartLibrary()` library load করে, `loadBusinessTrend()` API থেকে trend data নেয়, এবং `renderBusinessTrend()` chart তৈরি করে।

মূল ধারণাগুলো:

- `new Chart(canvas, config)`: একটি canvas element-এ নতুন chart তৈরি করে।
- `type`: chart-এর ধরন, যেমন `line` বা `bar`।
- `data.labels`: X-axis-এর label, যেমন মাসের নাম।
- `data.datasets`: প্রতিটি line/bar-এর value, label ও color।
- `options`: tooltip, legend, axis, responsive layout ও animation setting।
- `chart.destroy()`: পুরোনো chart মুছে দেয়; একই canvas-এ নতুন chart আঁকার আগে এটি দরকার।
- `plugins`: extra behavior যোগ করে। এই project-এ `businessTrendHoverLinePlugin` hover করা point-এর পাশে একটি vertical guide line আঁকে।

এই file-এর সব logic এক লাইনে compressed করা, কারণ browser দ্রুত download করে parse করতে পারে। তাই এর ভিতরে comment না দিয়ে project code থেকে library call কোথায় হচ্ছে সেটি commented রাখা হয়েছে।
