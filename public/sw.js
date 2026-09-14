'use strict';

const CACHE = 'cls-top20-v2';
const SHELL = ['./', './top20.json', './manifest.webmanifest', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) {
    return Promise.all(SHELL.map(function (url) { return cache.add(url).catch(function () {}); }));
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (key) { return key !== CACHE; }).map(function (key) { return caches.delete(key); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  var url;
  try { url = new URL(event.request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  var isData = url.pathname.endsWith('/top20.json');
  var cacheKey = new Request(url.origin + url.pathname);
  event.respondWith(fetch(event.request).then(function (response) {
    if (response && response.ok) {
      var copy = response.clone();
      caches.open(CACHE).then(function (cache) { cache.put(cacheKey, copy); });
    }
    return response;
  }).catch(function () {
    return caches.match(cacheKey).then(function (hit) { return hit || (isData ? Response.error() : caches.match('./')); });
  }));
});
