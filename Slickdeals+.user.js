// ==UserScript==
// @name         Slickdeals+
// @namespace    V@no
// @description  Adds a dropdown menu with advanced filtering, highlighting, ad blocking, and price difference display.
// @match        https://slickdeals.net/*
// @version      28.0.0
// @license      MIT
// @run-at       document-idle
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function() {
    'use strict';

    // =================================================================================
    // CONFIGURATION
    // =================================================================================
    const SELECTORS = {
        navBar: 'ul.slickdealsHeader__linkSection',
        sideColumn: '#sideColumn, aside.slickdealsSidebar',
        mainContent: '#mainColumn, .redesignFrontpageDesktop__main',
        pageGrid: '.redesignFrontpageDesktop',
        justForYou: '[data-section-title="Just For You"], .frontpageRecommendationCarousel',
        ads: [ // REMOVED: .rightRailBannerSection, .stickyRightRailWrapper to let hideSideColumn handle it.
            "#crt-adblock-a", "#crt-adblock-b",
            ".frontpageGrid__bannerAd", ".ad", ".variableWidthAd", ".variableHeightAd",
            ".frontpageAd__middleBanner", "[data-googleQueryId]", ".adunit", "div[data-adlocation]"
        ],
        dealFeed: 'ul.frontpageGrid',
        dealCard: '.dealCard',
        dealCardContent: '.dealCard__content',
        dealPrice: '.dealCard__price',
        originalPrice: '.dealCard__originalPrice',
        voteCount: '.dealCardSocialControls__voteCount',
        dealBadge: '.dealCardBadge',
        priceContainer: '.dealCard__priceContainer'
    };

    const CLASS_NAMES = {
        HIGHLIGHT_RATING: 'highlightRating',
        HIGHLIGHT_DIFF: 'highlightDiff',
        HIGHLIGHT_BOTH: 'highlightBoth',
        IS_FREE: 'isFree',
        IS_PROMOTED: 'isPromoted',
        IS_GOLD: 'isGold',
        HIDE: 'sd-plus-hide'
    };

    const DEFAULTS = {
        hideSideColumn: true,
        hideFeedAds: true,
        showDiff: true,
        priceFirst: true,
        hideJustForYou: true,
        hidePromoted: false,
        freeOnly: false,
        goldTierOnly: false,
        highlightRating: 40,
        highlightDiff: 50,
        colorRatingBG: '#dff0d8',
        colorDiffBG: '#d9edf7',
        colorBothBG: '#FFF9C4',
    };

    let settings = {};
    let styleEl = null;
    let processTimeout;

    // =================================================================================
    // UTILITY FUNCTIONS
    // =================================================================================
    function waitForElement(selector, parent = document, timeout = 3000) {
        return new Promise(resolve => {
            const el = parent.querySelector(selector);
            if (el) return resolve(el);
            const observer = new MutationObserver(() => {
                const foundEl = parent.querySelector(selector);
                if (foundEl) { observer.disconnect(); resolve(foundEl); }
            });
            observer.observe(parent, { childList: true, subtree: true });
            setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
        });
    }

    function parsePrice(text) {
        if (!text) return NaN;
        text = text.trim().toLowerCase();
        if (text.includes('free')) return 0;
        const match = text.match(/[\d,]+(\.\d{2})?/);
        return match ? parseFloat(match[0].replace(/,/g, '')) : NaN;
    }

    // =================================================================================
    // SETTINGS & MENU LOGIC
    // =================================================================================
    function loadSettings() {
        try {
            const saved = GM_getValue('sdPlus_settings_v28');
            settings = saved ? JSON.parse(saved) : { ...DEFAULTS };
            for (const key in DEFAULTS) {
                if (settings[key] === undefined) settings[key] = DEFAULTS[key];
            }
        } catch (error) {
            console.error('Slickdeals+ Error loading settings:', error);
            settings = { ...DEFAULTS };
        }
    }

    function saveSettings(reprocess = false) {
        GM_setValue('sdPlus_settings_v28', JSON.stringify(settings));
        updateHtmlClasses();
        applyAllStyles();
        if (reprocess) {
            clearTimeout(processTimeout);
            processTimeout = setTimeout(processAllCards, 250);
        }
    }

    function updateHtmlClasses() {
        for (const key in settings) {
            if (typeof settings[key] === 'boolean') {
                document.documentElement.classList.toggle(`${key}-enabled`, settings[key]);
            }
        }
    }

    function createMenu() {
        const navBar = document.querySelector(SELECTORS.navBar);
        if (!navBar) return;
        const menuHTML = `
            <li class="slickdealsHeader__link slickdealsHeaderLink" id="sdPlusNavMenu">
                <div class="sd-plus-menu-button">Slickdeals+</div>
                <div id="sdPlusMenuDropdown" class="sd-plus-menu-dropdown">
                    <div id="sdPlusMenuBody">
                        <div class="sd-plus-section">
                            <h4>Display Toggles</h4>
                            <label><input type="checkbox" data-setting="priceFirst"> Price First (Above Title)</label>
                            <label><input type="checkbox" data-setting="showDiff"> Show Price Difference</label>
                            <label><input type="checkbox" data-setting="hideJustForYou"> Hide "Just For You"</label>
                            <label><input type="checkbox" data-setting="hideSideColumn"> Hide Side Column</label>
                            <label><input type="checkbox" data-setting="hideFeedAds"> Block Ads</label>
                            <label><input type="checkbox" data-setting="hidePromoted"> Hide Promoted Deals</label>
                        </div>
                        <div class="sd-plus-section">
                            <h4>Deal Filters</h4>
                            <label><input type="checkbox" data-setting="freeOnly"> Show Free Items Only</label>
                            <label><input type="checkbox" data-setting="goldTierOnly"> Show "Gold Tier" Only</label>
                        </div>
                        <div class="sd-plus-section">
                            <h4>Highlighting</h4>
                            <label><span>Highlight Score ≥</span><input type="number" data-setting="highlightRating" class="sd-plus-input-number"></label>
                            <label><span>Score Color:</span><input type="color" data-setting="colorRatingBG"></label>
                            <label><span>Highlight Discount ≥ (%)</span><input type="number" data-setting="highlightDiff" class="sd-plus-input-number"></label>
                            <label><span>Discount Color:</span><input type="color" data-setting="colorDiffBG"></label>
                            <label><span>"Gold Tier" Color:</span><input type="color" data-setting="colorBothBG"></label>
                        </div>
                        <button id="sdPlusResetButton">Reset to Defaults</button>
                    </div>
                </div>
            </li>
        `;
        navBar.insertAdjacentHTML('beforeend', menuHTML);
        populateMenu();
        setupEventListeners();
    }

    function populateMenu() {
        document.querySelectorAll('[data-setting]').forEach(el => {
            const key = el.dataset.setting;
            if (el.type === 'checkbox') el.checked = settings[key];
            else el.value = settings[key];
        });
    }

    async function handleFilterChange(key, value) {
        if (key === 'freeOnly' && value) settings.goldTierOnly = false;
        if (key === 'goldTierOnly' && value) settings.freeOnly = false;
        populateMenu();
        if (value) {
            await saveSettings(true);
            reorganizeAndSortFeed(key === 'freeOnly' ? `.${CLASS_NAMES.IS_FREE}` : `.${CLASS_NAMES.IS_GOLD}`);
        } else {
            await saveSettings();
            location.reload();
        }
    }

    function setupEventListeners() {
        const menuBody = document.getElementById('sdPlusMenuBody');
        if (!menuBody) return;
        menuBody.addEventListener('change', (e) => {
            const el = e.target;
            const key = el.dataset.setting;
            if (!key) return;
            let value = el.type === 'checkbox' ? el.checked : el.value;
            if (el.type === 'number') value = parseInt(value, 10) || 0;
            settings[key] = value;
            if (key === 'freeOnly' || key === 'goldTierOnly') handleFilterChange(key, value);
            else saveSettings(true);
        });
        document.getElementById('sdPlusResetButton').addEventListener('click', () => {
            if (confirm('Reset all settings to default?')) {
                settings = { ...DEFAULTS };
                populateMenu();
                saveSettings(true);
            }
        });
        const menuContainer = document.getElementById('sdPlusNavMenu');
        menuContainer.querySelector('.sd-plus-menu-button').addEventListener('click', e => { e.stopPropagation(); menuContainer.classList.toggle('menu-open'); });
        document.addEventListener('click', () => menuContainer.classList.remove('menu-open'));
        menuBody.addEventListener('click', e => e.stopPropagation());
    }

    function applyAllStyles() {
        if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'sdPlusStyles';
            document.head.appendChild(styleEl);
        }
        const adStyle = settings.hideFeedAds ? `${SELECTORS.ads.join(', ')} { display: none !important; }` : '';
        const justForYouStyle = settings.hideJustForYou ? `${SELECTORS.justForYou} { display: none !important; }` : '';
        // FIX: Target the parent <li> of the promoted card to prevent empty spaces in the grid.
        const promotedStyle = settings.hidePromoted ? `li:has(${SELECTORS.dealCard}.${CLASS_NAMES.IS_PROMOTED}) { display: none !important; }` : '';

        // **CORE LAYOUT FIX**
        // This is the robust, simplified CSS for handling the side column toggle.
        // It works by collapsing the site's native CSS grid to a single column,
        // which allows the browser and the site's own `margin: 0 auto` styles
        // to handle the centering naturally and correctly.
        //
        // This is superior to the old method which:
        // 1. Used `grid-template-columns: minmax(0, 1fr) 0;` which was brittle.
        // 2. Used fixed-width media queries which fought against the site's responsive design.
        const pageLayoutStyle = `
            /* Hide the side column */
            html.hideSideColumn-enabled ${SELECTORS.sideColumn} {
                display: none !important;
            }

            /* Adjust the page grid to a single column, removing gap and reserved space */
            html.hideSideColumn-enabled ${SELECTORS.pageGrid} {
                display: grid !important;
                grid-template-columns: 1fr !important;
                column-gap: 0 !important;
            }

            /* Ensure main content takes full width of the single column */
            html.hideSideColumn-enabled ${SELECTORS.mainContent} {
                width: 100% !important;
                max-width: 100% !important;
            }
        `;

        // Definitive layout CSS based on v26's logic and user-provided screenshots
        const layoutStyle = `
            /* --- Default layout (Title First) --- */
            html:not(.priceFirst-enabled) ${SELECTORS.dealCardContent} {
                grid-template-areas: "image image image" "title title title" "price originalPrice fireIcon" "extraInfo extraInfo extraInfo" "store store store" !important;
                grid-template-rows: auto auto 1.5em 1fr 20px !important;
            }

            /* --- Default layout with Price Difference --- */
            html:not(.priceFirst-enabled).showDiff-enabled ${SELECTORS.dealCardContent} {
                grid-template-rows: auto auto 3em 1fr 20px !important;
            }

            /* --- Price First Layout --- */
            html.priceFirst-enabled ${SELECTORS.dealCardContent} {
                grid-template-areas: "image image image" "price originalPrice fireIcon" "title title title" "extraInfo extraInfo extraInfo" "store store store" !important;
                grid-template-rows: auto 1.5em auto 1fr 20px !important;
            }
            /* --- Price First with Price Difference --- */
            html.priceFirst-enabled.showDiff-enabled ${SELECTORS.dealCardContent} {
                grid-template-rows: auto 3em auto 1fr 20px !important;
            }
            html.showDiff-enabled ${SELECTORS.priceContainer}[data-deal-percent]::after {
                content: "($" attr(data-deal-diff) " | " attr(data-deal-percent) "%)";
                display: block;
                width: 100%;
                font-style: italic;
                margin-top: 4px;
                color: #555;
                font-size: 0.9em;
            }

            /* This is the missing piece: ensure the price container is a wrapping flexbox */
            ${SELECTORS.priceContainer} {
                display: flex !important;
                flex-wrap: wrap !important;
                align-items: baseline;
            }
        `;

        styleEl.textContent = `
            #sdPlusNavMenu { position: relative; }
            .sd-plus-menu-button { cursor: pointer; color: #333; font-weight: bold; padding: 6px 10px; background-color: #fff; border: 1px solid #ccc; border-radius: 4px; }
            .sd-plus-menu-dropdown { display: none; }
            #sdPlusNavMenu.menu-open .sd-plus-menu-dropdown { display: block; position: absolute; top: 100%; left: 0; width: 320px; background-color: #ffffff; border: 1px solid #ccc; border-radius: 5px; z-index: 10000; font-family: Arial, sans-serif; font-size: 14px; color: #333; text-align: left; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            #sdPlusMenuBody { padding: 15px; } .sd-plus-section { margin-bottom: 15px; border-bottom: 1px solid #eee; padding-bottom: 15px; } #sdPlusMenuBody h4 { margin: 0 0 10px 0; } #sdPlusMenuBody label { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; } .sd-plus-input-number { width: 50px; text-align: right; } #sdPlusResetButton { width: 100%; margin-top: 10px; background-color: #f44336; color: white; border: none; padding: 10px 15px; border-radius: 5px; cursor: pointer; } #sdPlusResetButton:hover { background-color: #d32f2f; }
            .dealCard.${CLASS_NAMES.HIDE} { display: none !important; }
            .dealCard.${CLASS_NAMES.HIGHLIGHT_RATING} { background-color: ${settings.colorRatingBG} !important; }
            .dealCard.${CLASS_NAMES.HIGHLIGHT_DIFF} { background-color: ${settings.colorDiffBG} !important; }
            .dealCard.${CLASS_NAMES.HIGHLIGHT_BOTH} { background-color: ${settings.colorBothBG} !important; }
            ${layoutStyle}
            ${pageLayoutStyle}
            ${adStyle}
            ${justForYouStyle}
            ${promotedStyle}
        `;
    }

    // =================================================================================
    // CORE LOGIC
    // =================================================================================
    function reorganizeAndSortFeed(filterClass) {
        const dealFeed = document.querySelector(SELECTORS.dealFeed);
        if (!dealFeed) return;
        const matchingCards = Array.from(dealFeed.querySelectorAll(`${SELECTORS.dealCard}${filterClass}`));
        matchingCards.sort((a, b) => {
            // FIX: The date attribute is on the parent <li>, not the deal card itself.
            const parentA = a.closest('li');
            const parentB = b.closest('li');
            const dateA = new Date(parentA ? parentA.getAttribute('data-lastpostat') || 0 : 0);
            const dateB = new Date(parentB ? parentB.getAttribute('data-lastpostat') || 0 : 0);
            return dateB - dateA;
        });
        matchingCards.forEach(card => {
            const parentListItem = card.closest('li');
            if (parentListItem) dealFeed.prepend(parentListItem);
        });
    }

    function applyHighlights(card, { meetsRating, meetsDiff }) {
        if (meetsRating && meetsDiff) card.classList.add(CLASS_NAMES.HIGHLIGHT_BOTH, CLASS_NAMES.IS_GOLD);
        else if (meetsRating) card.classList.add(CLASS_NAMES.HIGHLIGHT_RATING);
        else if (meetsDiff) card.classList.add(CLASS_NAMES.HIGHLIGHT_DIFF);
    }

    function applyFilters(card, { isFree, isGold }) {
        const shouldHide = (settings.freeOnly && !isFree) || (settings.goldTierOnly && !isGold);
        card.classList.toggle(CLASS_NAMES.HIDE, shouldHide);
    }

    async function processDealCard(card) {
        if (card.dataset.sdpProcessed) return;
        try {
            const [priceEl, originalEl, voteEl, badgeEl, priceContainer] = await Promise.all([
                waitForElement(SELECTORS.dealPrice, card, 500),
                waitForElement(SELECTORS.originalPrice, card, 500),
                waitForElement(SELECTORS.voteCount, card, 500),
                waitForElement(SELECTORS.dealBadge, card, 500),
                waitForElement(SELECTORS.priceContainer, card, 500)
            ]);
            if (!priceEl || !priceContainer) return;

            card.className = card.className.split(' ').filter(c => !c.startsWith('highlight') && !c.startsWith('is') && c !== CLASS_NAMES.HIDE).join(' ');
            
            const rePriceOff = /(?:\$?([\d,.]+))?\s?off(?:\s\$?([\d,.]+))?$/i;
            const priceText = priceEl.textContent.trim();
            let currentPrice = parsePrice(priceText);
            let originalPriceVal = parsePrice(originalEl?.textContent);
            const offMatch = priceText.match(rePriceOff);
            if (offMatch) {
                const basePrice = originalPriceVal || parseFloat(offMatch[2]?.replace(/,/g, ''));
                const discount = parseFloat(offMatch[1]?.replace(/,/g, ''));
                if (!isNaN(basePrice) && !isNaN(discount)) {
                    currentPrice = basePrice - discount;
                    originalPriceVal = basePrice;
                }
            }

            const votes = parseInt(voteEl?.textContent || '0');
            const dealProps = {
                isFree: currentPrice === 0,
                isPromoted: badgeEl?.textContent?.toLowerCase().includes('promoted'),
                meetsRating: votes >= settings.highlightRating,
                meetsDiff: false,
                isGold: false
            };
            
            delete priceContainer.dataset.dealDiff;
            delete priceContainer.dataset.dealPercent;
            if (!isNaN(currentPrice) && !isNaN(originalPriceVal) && originalPriceVal > currentPrice) {
                const diff = (originalPriceVal - currentPrice).toFixed(2);
                const percent = Math.round((1 - currentPrice / originalPriceVal) * 100);
                dealProps.meetsDiff = percent >= settings.highlightDiff;
                priceContainer.dataset.dealDiff = diff;
                priceContainer.dataset.dealPercent = percent;
            }
            
            dealProps.isGold = dealProps.meetsRating && dealProps.meetsDiff;
            applyHighlights(card, dealProps);
            card.classList.toggle(CLASS_NAMES.IS_FREE, dealProps.isFree);
            card.classList.toggle(CLASS_NAMES.IS_PROMOTED, dealProps.isPromoted);
            applyFilters(card, dealProps);

        } catch (error) {
            console.error('Slickdeals+ Error processing card:', error, card);
        } finally {
            card.dataset.sdpProcessed = 'true';
        }
    }

    async function processAllCards() {
        // FIX: Use Promise.all to ensure all async card processing is complete before continuing.
        const cards = document.querySelectorAll(SELECTORS.dealCard);
        const processingPromises = Array.from(cards).map(card => {
            delete card.dataset.sdpProcessed;
            return processDealCard(card);
        });
        await Promise.all(processingPromises);
    }

    // =================================================================================
    // INITIALIZATION
    // =================================================================================
    async function init() {
        if (!document.querySelector(SELECTORS.navBar) && !document.querySelector(SELECTORS.dealCard)) {
            console.error("Slickdeals+ Halt: Critical selectors missing.");
            return;
        }

        loadSettings();
        updateHtmlClasses();
        applyAllStyles();
        createMenu();
        await processAllCards();

        // FIX: Re-sort the feed on page load if a filter is active.
        if (settings.goldTierOnly) {
            reorganizeAndSortFeed(`.${CLASS_NAMES.IS_GOLD}`);
        } else if (settings.freeOnly) {
            reorganizeAndSortFeed(`.${CLASS_NAMES.IS_FREE}`);
        }

        const dealFeed = await waitForElement(SELECTORS.dealFeed);
        if (!dealFeed) return;

        const observer = new MutationObserver((mutations) => {
            try {
                const addedCards = new Set();
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === 1) {
                            if (node.matches(SELECTORS.dealCard)) addedCards.add(node);
                            node.querySelectorAll(SELECTORS.dealCard).forEach(c => addedCards.add(c));
                        }
                    }
                }
                addedCards.forEach(processDealCard);
            } catch (e) {
                console.error('Slickdeals+ MutationObserver failed:', e);
            }
        });
        observer.observe(dealFeed, { childList: true, subtree: true });
    }

    init();

})();