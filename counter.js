(function () {
    'use strict';

    // ============================================================
    // State
    // ============================================================
    let config = null;
    let currentPath = '';
    let pageviewSent = false;

    // Scroll tracking
    let documentHeight = 0;
    let maxScrollDepth = 0;

    // Engagement tracking
    let engagementStart = null;
    let accumulatedEngagement = 0;
    let engagementTimerActive = false;
    let engagementSent = false;

    const pageLoadTime = performance.now();

    function getCustomProps(scriptElement) {
        if (!scriptElement) return null;

        const props = {};
        const attrs = scriptElement.attributes;

        for (let i = 0; i < attrs.length; i++) {
            const name = attrs[i].name;
            if (name.startsWith('data-usd-')) {
                const key = name.slice(9);
                props[key] = attrs[i].value;
            }
        }

        return Object.keys(props).length > 0 ? props : null;
    }

    // ============================================================
    // Configuration
    // ============================================================
    function initConfig(scriptElement) {
        const scriptSrc = scriptElement?.src || '';
        const defaultEndpoint = scriptSrc ? new URL(scriptSrc).origin + '/api/event' : '';

        config = {
            endpoint: scriptElement?.getAttribute('data-api') || defaultEndpoint,
            siteId: parseInt(scriptElement?.getAttribute('data-id'), 10),
            uniqueId: scriptElement?.getAttribute('data-u'),
            logging: true,
            customProps: getCustomProps(scriptElement),
            beforeSend : scriptElement?.getAttribute('data-before-send') || null,
        };
    }

    function getCurrentUrl() {
        try {
            return location.href || '';
        } catch {
            return '';
        }
    }

    // ============================================================
    // Scroll Tracking
    // ============================================================
    function getDocumentHeight() {
        return Math.max(
            document.body.scrollHeight,
            document.documentElement.scrollHeight
        );
    }

    function getCurrentScrollDepth() {
        const scrollTop = window.scrollY;
        const winHeight = window.innerHeight;
        return Math.min(scrollTop + winHeight, documentHeight);
    }

    function getScrollPercentage() {
        if (!documentHeight) return 0;
        return Math.min(Math.round((maxScrollDepth / documentHeight) * 100), 100)
    }

    function resetScrollTracking() {
        documentHeight = getDocumentHeight();
        maxScrollDepth = getCurrentScrollDepth();
    }

    // requestAnimationFrame scroll listener (самый корректный способ)
    function setupScrollTracking() {
        let ticking = false;

        window.addEventListener('scroll', () => {
            if (!ticking) {
                ticking = true;
                requestAnimationFrame(() => {
                    const depth = getCurrentScrollDepth();
                    if (depth > maxScrollDepth) maxScrollDepth = depth;
                    ticking = false;
                });
            }
        }, { passive: true });

        window.addEventListener('load', () => {
            documentHeight = getDocumentHeight();

            // подгрузка динамических блоков
            let attempts = 10;
            const interval = setInterval(() => {
                documentHeight = getDocumentHeight();
                if (--attempts <= 0) clearInterval(interval);
            }, 300);
        });
    }

    // ============================================================
    // Engagement Tracking
    // ============================================================
    function startEngagement() {
        if (!engagementTimerActive) {
            engagementStart = Date.now();
            engagementTimerActive = true;
        }
    }

    function pauseEngagement() {
        if (engagementTimerActive) {
            accumulatedEngagement += Date.now() - engagementStart;
            engagementTimerActive = false;
        }
    }

    function getEngagementTime() {
        return accumulatedEngagement +
            (engagementTimerActive ? Date.now() - engagementStart : 0);
    }

    function resetEngagementTracking() {
        engagementStart = null;
        accumulatedEngagement = 0;
        engagementTimerActive = false;
    }

    function handleVisibilityChange() {
        if (document.visibilityState === 'visible') startEngagement();
        else pauseEngagement();
    }

    // ============================================================
    // Sending events
    // ============================================================
    function sendRequest(data, callback) {
        if (!config || !window.fetch) return;
        if ( !shouldTrack() ) return;

        if ( config.beforeSend ) {
            try {
                const fn = window[config.beforeSend];
                if ( typeof fn === 'function' ) {
                    if ( !('p' in data) ) data.p = {};
                    data.p = fn(data.p);
                }
            } catch (e)  {
            }
        }

        fetch(config.endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            keepalive: true,
            body: JSON.stringify(data),
        })
            .then((r) => callback?.({ status: r.status }))
            .catch((e) => callback?.({ error: e }));
    }

    function shouldTrack() {
        if (/^localhost$|^127(\.\d+){0,2}\.\d+$/.test(location.hostname)) return false;
        if (window.navigator.webdriver || window.Cypress) return false;
        try {
            if (localStorage.getItem('analytics_ignore') === 'true') return false;
        } catch {}
        return true;
    }

    function basePayload() {
        const payload =  {
            u: getCurrentUrl(),
            hu: config.uniqueId,
            i: config.siteId,
            r: document.referrer || null,
        };

        if (config.customProps) {
            payload.p = config.customProps;
        }
        return payload;
    }

    function trackEvent(name, props = {}) {
        sendRequest({
            n: name,
            ...basePayload(),
            ...props
        });
    }

    function trackPageview() {
        resetScrollTracking();
        resetEngagementTracking();
        startEngagement();

        trackEvent('pageview');

        pageviewSent = true;
        engagementSent = false;
    }

    function trackEngagement() {
        if (!pageviewSent || engagementSent) return;

        const time = getEngagementTime();

        if (time < 2000 && maxScrollDepth === 0) return; // защита от мусора

        pauseEngagement();

        trackEvent('engagement', {
            sd: getScrollPercentage(),
            e: time,
            h: 1,
            tt : Math.round(performance.now() - pageLoadTime)
        });

        resetEngagementTracking();
        engagementSent = true;
    }

    // ============================================================
    // Navigation
    // ============================================================
    function handleRouteChange() {
        const path = location.pathname;
        if (path !== currentPath) {
            if (currentPath) trackEngagement();  // закрыть старую страницу

            currentPath = path;
            pageviewSent = false;
            trackPageview();
        }
    }

    function setupNavigation() {
        const wrap = (method) => {
            const original = history[method];
            history[method] = function() {
                original.apply(this, arguments);
                handleRouteChange();
            };
        };

        wrap('pushState');
        wrap('replaceState');

        window.addEventListener('popstate', handleRouteChange);
        window.addEventListener('pushstate', handleRouteChange);
        window.addEventListener('replacestate', handleRouteChange);

        window.addEventListener('beforeunload', trackEngagement);
        window.addEventListener('pagehide', trackEngagement);

        window.addEventListener('pageshow', (e) => {
            if (e.persisted) handleRouteChange();
        });
    }

    // ============================================================
    // Init
    // ============================================================
    function init() {
        initConfig(document.currentScript);

        setupScrollTracking();
        setupNavigation();

        document.addEventListener('visibilitychange', handleVisibilityChange);
        window.addEventListener('focus', startEngagement);
        window.addEventListener('blur', pauseEngagement);

        handleRouteChange();

        if (document.visibilityState === 'visible') startEngagement();
    }

    init();
})();


