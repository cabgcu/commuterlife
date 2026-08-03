// Commuter Life Service Worker — handles push notifications
const SUPABASE_URL = 'https://jkcfpiuhbtbrgtrususe.supabase.co';
const SUPABASE_KEY = 'sb_publishable_wDyZ8w_AJv7Fvv1hjxWkSQ_biX3jRbB';

self.addEventListener('install', (e) => e.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
    // iOS REQUIRES showing a notification from every push event.
    // Always show immediately — never skip or defer.

    let data = {};
    if (e.data) {
        try {
            data = e.data.json();
        } catch (err) {
            data = { title: 'Commuter Life', body: e.data.text() };
        }
    }

    // If we successfully parsed the payload and it has a title (from our Edge Function)
    if (data && (data.title || (data.notification && data.notification.title))) {
        // Handle cases where payload might be nested in a `notification` object
        const notifTitle = data.title || data.notification.title;
        const notifBody = data.body || data.notification?.body || '';
        const notifIcon = data.icon || data.notification?.icon || '';
        const notifTag = data.tag || data.notification?.tag || 'commuter-notif-' + Date.now();
        const notifData = data.data || data.notification?.data || {};

        const promiseChain = self.registration.showNotification(notifTitle, {
            body: notifBody,
            icon: notifIcon,
            tag: notifTag,
            data: notifData,
            renotify: false,
            requireInteraction: false
        });

        e.waitUntil(promiseChain);
        return;
    }

    // Fallback: if somehow we got an empty push, show a generic notification immediately
    // then try to fetch details (but don't block on it)
    const fallbackTag = 'commuter-notif-fallback';

    const fallbackChain = self.registration.showNotification('Commuter Life', {
        body: 'Checking for new updates...',
        tag: fallbackTag,
        renotify: true
    }).then(() => {
        // Figure out which user this device's push subscription belongs to,
        // so the fallback only ever surfaces THIS user's notifications. This
        // is a shared multi-user app — without this check, the fallback used
        // to pick the single most-recently-created unread notification across
        // every user's inbox and show its title/body on whichever device
        // happened to receive an empty push payload, leaking another
        // person's notification content onto your device.
        return self.registration.pushManager.getSubscription().then(sub => {
            const myEndpoint = sub && sub.endpoint;
            return fetch(SUPABASE_URL + '/rest/v1/app_state?select=data&id=eq.1', {
                headers: { 'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY }
            })
            .then(r => r.json())
            .then(rows => {
                if (!rows || !rows[0] || !rows[0].data) return;
                const appData = rows[0].data;
                const allNotifs = appData.notifications || {};
                const subscriptions = appData.pushSubscriptions || {};

                let ownerName = null;
                if (myEndpoint) {
                    for (const user in subscriptions) {
                        const raw = subscriptions[user];
                        const list = Array.isArray(raw) ? raw : (raw && raw.endpoint ? [raw] : []);
                        if (list.some(s => s && s.endpoint === myEndpoint)) { ownerName = user; break; }
                    }
                }
                if (!ownerName) return; // can't identify the owner — don't guess

                const userNotifs = allNotifs[ownerName] || [];
                let latest = null;
                for (const n of userNotifs) {
                    if (!n.read && (!latest || new Date(n.timestamp) > new Date(latest.timestamp))) {
                        latest = n;
                    }
                }
                if (latest) {
                    return self.registration.showNotification(latest.title || 'Commuter Life', {
                        body: latest.body || 'You have a new notification',
                        tag: fallbackTag,
                        data: { taskId: latest.taskId, type: latest.type },
                        renotify: true
                    });
                }
            });
        })
        .catch(err => console.error('Fallback fetch failed:', err));
    });

    e.waitUntil(fallbackChain);
});

self.addEventListener('notificationclick', (e) => {
    e.notification.close();

    const urlToOpen = new URL('./', self.location).href;

    e.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
            // Try to find an existing window to focus
            for (const client of clients) {
                // Use .includes for iOS PWA URL safety
                if (client.url && client.url.includes(self.location.origin)) {
                    client.focus();
                    if (e.notification.data) {
                        client.postMessage({ type: 'NOTIF_CLICK', data: e.notification.data });
                    }
                    return;
                }
            }
            // If no window is found, open a new one
            return self.clients.openWindow(urlToOpen);
        })
    );
});
