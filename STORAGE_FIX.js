/**
 * COMMUTER LIFE - STORAGE BUG FIX
 * 
 * Fixes critical issue where storage items and images disappear on mobile
 * when adding new items
 * 
 * ROOT CAUSES:
 * 1. View container display property being reset after adds
 * 2. Drag-drop polyfill interfering with DOM elements
 * 3. Image blob URLs not being preserved
 * 4. Rapid state updates causing flicker and removal
 */

(function() {
    'use strict';

    const STORAGE_KEY = 'commuterlife_items';
    const STORAGE_BACKUP_KEY = 'commuterlife_items_backup';
    let currentItems = [];
    let storageViewObserver = null;

    /**
     * CRITICAL FIX #1: Prevent view container from hiding on updates
     */
    function protectStorageViewContainer() {
        const storageView = document.getElementById('view-storage');
        if (!storageView) return;

        // Watch for any attempts to hide the view
        const config = {
            attributes: true,
            attributeFilter: ['style', 'display'],
            subtree: false
        };

        storageViewObserver = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.target.id === 'view-storage') {
                    const elem = mutation.target;
                    
                    // Force visibility if it has active class
                    if (elem.classList.contains('active')) {
                        if (elem.style.display === 'none' || getComputedStyle(elem).display === 'none') {
                            elem.style.display = 'flex !important';
                            elem.style.visibility = 'visible !important';
                            console.log('🔧 Storage view protection: Restored visibility');
                        }
                    }
                }
            });
        });

        storageViewObserver.observe(storageView, config);
        console.log('✓ Storage view protection enabled');
    }

    /**
     * CRITICAL FIX #2: Prevent mobile drag-drop polyfill from removing elements
     */
    function disableDragDropInterference() {
        // Safely disable the polyfill's DOM manipulation
        if (window.MobileDragDrop) {
            const polyfillInit = window.MobileDragDrop.polyfill;
            if (polyfillInit) {
                window.MobileDragDrop.polyfill = function(options = {}) {
                    // Exclude storage elements from polyfill
                    options.excludeSelector = (options.excludeSelector || '') + 
                        ', .storage-bin, .storage-item, [data-storage-item], img[data-src]';
                    
                    try {
                        return polyfillInit(options);
                    } catch (e) {
                        console.warn('Polyfill init had issue, continuing:', e);
                    }
                };
            }
        }

        // Prevent accidental element removal during drag ops
        const originalRemove = Element.prototype.remove;
        Element.prototype.remove = function() {
            if (this.classList?.contains('storage-bin') || 
                this.classList?.contains('storage-item') ||
                this.dataset?.storageItem) {
                console.warn('⚠️ Prevented removal of storage element:', this);
                return; // Don't remove storage elements
            }
            return originalRemove.call(this);
        };

        console.log('✓ Drag-drop interference disabled');
    }

    /**
     * CRITICAL FIX #3: Preserve image blob URLs
     */
    function preserveImageBlobs() {
        const blobCache = new Set();

        // Track all blob URLs in use
        const originalCreateObjectURL = URL.createObjectURL;
        URL.createObjectURL = function(blob) {
            const url = originalCreateObjectURL.call(this, blob);
            blobCache.add(url);
            return url;
        };

        // Don't revoke blob URLs while images are still visible
        const originalRevokeObjectURL = URL.revokeObjectURL;
        URL.revokeObjectURL = function(url) {
            const isInUse = !!document.querySelector(`img[src="${url}"]`);
            if (isInUse) {
                console.log('⚠️ Prevented revocation of blob URL still in use:', url);
                return;
            }
            blobCache.delete(url);
            return originalRevokeObjectURL.call(this, url);
        };

        console.log('✓ Image blob preservation enabled');
    }

    /**
     * CRITICAL FIX #4: Debounce rapid state updates that cause flicker
     */
    function createSafeStateUpdater() {
        let updateTimeout = null;
        let pendingUpdate = null;

        return {
            queue: (updateFn) => {
                pendingUpdate = updateFn;
                
                if (updateTimeout) {
                    clearTimeout(updateTimeout);
                }

                updateTimeout = setTimeout(() => {
                    if (pendingUpdate) {
                        // Ensure view is still visible before update
                        const storageView = document.getElementById('view-storage');
                        if (storageView?.classList.contains('active')) {
                            storageView.style.display = 'flex';
                        }

                        pendingUpdate();
                        pendingUpdate = null;
                    }
                }, 200); // 200ms debounce
            },
            flush: () => {
                if (updateTimeout) {
                    clearTimeout(updateTimeout);
                    if (pendingUpdate) {
                        pendingUpdate();
                        pendingUpdate = null;
                    }
                }
            }
        };
    }

    /**
     * RECOVERY: Attempt to restore missing items from backup
     */
    function attemptStorageRecovery() {
        try {
            // Check if items exist
            const mainItems = localStorage.getItem(STORAGE_KEY);
            if (mainItems) {
                currentItems = JSON.parse(mainItems);
                return;
            }

            // Try backup
            const backupItems = localStorage.getItem(STORAGE_BACKUP_KEY);
            if (backupItems) {
                currentItems = JSON.parse(backupItems);
                localStorage.setItem(STORAGE_KEY, backupItems);
                console.log('✓ RECOVERED ' + currentItems.length + ' items from backup!');
                return;
            }

            // Check Supabase as last resort (if available)
            if (window.supabase) {
                console.log('💡 TIP: Check your Supabase storage table for archived items');
            }
        } catch (e) {
            console.error('Recovery attempt failed:', e);
        }
    }

    /**
     * BACKUP: Auto-save items on any storage operation
     */
    function autoBackupStorageItems() {
        const originalSetItem = Storage.prototype.setItem;

        Storage.prototype.setItem = function(key, value) {
            if (key === STORAGE_KEY) {
                // Create backup
                this.setItem(STORAGE_BACKUP_KEY, value);
                console.log('📦 Auto-backup created');
            }
            return originalSetItem.call(this, key, value);
        };
    }

    /**
     * MONITOR: Watch for items disappearing and alert user
     */
    function monitorForDataLoss() {
        let lastKnownCount = 0;

        setInterval(() => {
            try {
                const items = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
                
                if (items.length < lastKnownCount) {
                    console.warn('⚠️ ALERT: Item count decreased from', lastKnownCount, 'to', items.length);
                    
                    // Attempt recovery
                    const backup = JSON.parse(localStorage.getItem(STORAGE_BACKUP_KEY) || '[]');
                    if (backup.length > items.length) {
                        localStorage.setItem(STORAGE_KEY, JSON.stringify(backup));
                        console.log('🔄 Auto-recovered items from backup');
                    }
                }
                
                lastKnownCount = items.length;
            } catch (e) {
                // Silently fail
            }
        }, 5000); // Check every 5 seconds
    }

    /**
     * INITIALIZE ALL FIXES
     */
    function initialize() {
        console.log('🔧 Initializing Storage Fix v1.0');

        // Wait for DOM to be ready
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', initFixes);
        } else {
            initFixes();
        }

        function initFixes() {
            protectStorageViewContainer();
            disableDragDropInterference();
            preserveImageBlobs();
            autoBackupStorageItems();
            attemptStorageRecovery();
            monitorForDataLoss();
            
            console.log('✅ Storage fix fully initialized');
            console.log('📊 Current items in storage:', currentItems.length);
        }
    }

    // Export utilities
    window.StorageFix = {
        initialize,
        recover: attemptStorageRecovery,
        viewUpdater: createSafeStateUpdater(),
        getCurrentItems: () => currentItems,
        manualBackup: () => {
            try {
                const items = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
                localStorage.setItem(STORAGE_BACKUP_KEY, JSON.stringify(items));
                console.log('✓ Manual backup created');
            } catch (e) {
                console.error('Backup failed:', e);
            }
        }
    };

    // Auto-initialize
    initialize();

})();
