import { _decorator, Component } from "cc";
const { ccclass } = _decorator;

declare const window: any;

export enum analyticsEvents {
    // Loading and display events
    LOADING = "LOADING",
    LOADED = "LOADED",
    DISPLAYED = "DISPLAYED",

    // Challenge events
    CHALLENGE_STARTED = "CHALLENGE_STARTED",
    CHALLENGE_FAILED = "CHALLENGE_FAILED",
    CHALLENGE_RETRY = "CHALLENGE_RETRY",
    CHALLENGE_PASS_25 = "CHALLENGE_PASS_25",
    CHALLENGE_PASS_50 = "CHALLENGE_PASS_50",
    CHALLENGE_PASS_75 = "CHALLENGE_PASS_75",
    CHALLENGE_SOLVED = "CHALLENGE_SOLVED",

    // Completion and conversion events
    CTA_CLICKED = "CTA_CLICKED",
    ENDCARD_SHOWN = "ENDCARD_SHOWN",
}

@ccclass("Analytics")
export class Analytics extends Component {
    static _instance: Analytics;
    static get instance() {
        return this._instance;
    }

    // Debug counter for testing
    private static eventCounts: Map<string, number> = new Map();
    private static hasInitialized: boolean = false;

    onLoad() {
        Analytics._instance = this;
        
        // Fire LOADING event once on initialization
        if (!Analytics.hasInitialized) {
            Analytics.hasInitialized = true;
            this.dispatchEvent(analyticsEvents.LOADING);
        }
    }

    /**
     * Sends the event to AppLovin if the SDK is present, otherwise dispatches to the browser.
     */
    public dispatchEvent(eventName: analyticsEvents | string) {
        // Track event count for debugging
        const currentCount = (Analytics.eventCounts.get(eventName) || 0) + 1;
        Analytics.eventCounts.set(eventName, currentCount);
        console.log(`[Analytics] Event "${eventName}" sent (Total: ${currentCount})`);

        if (window.ALPlayableAnalytics && typeof window.ALPlayableAnalytics.trackEvent === "function") {
            window.ALPlayableAnalytics.trackEvent(eventName);
            console.log(`[AL Analytics] Sent: ${eventName}`);
        } else {
            // Local fallback for testing in browser console
            window.dispatchEvent(new Event(eventName));
            console.warn(`[Analytics Fallback] SDK Not Found. Dispatched Browser Event: ${eventName}`);
        }
    }
}