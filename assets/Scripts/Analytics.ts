import { _decorator, Component } from 'cc';
const { ccclass } = _decorator;

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
    private static _instance: Analytics | null = null;
    static get instance() {
        return this._instance;
    }

    private static eventCounts: Map<string, number> = new Map();
    private static sentEvents: Set<string> = new Set();

    onLoad() {
        Analytics._instance = this;
    }

    onDestroy() {
        if (Analytics._instance === this) Analytics._instance = null;
    }

    /**
     * Sends one of AppLovin's predefined events. This static entry point works
     * even when no Analytics component has been authored into the scene.
     */
    static trackEvent(eventName: analyticsEvents) {
        // AppLovin dedupes these events, and mirroring that behavior locally
        // protects against repeated component callbacks or CTA clicks.
        if (this.sentEvents.has(eventName)) return;
        this.sentEvents.add(eventName);

        const currentCount = (Analytics.eventCounts.get(eventName) || 0) + 1;
        Analytics.eventCounts.set(eventName, currentCount);
        console.log(`[Analytics] ${eventName} (${currentCount})`);

        const scope = globalThis as any;
        if (typeof scope.ALPlayableAnalytics !== 'undefined'
            && typeof scope.ALPlayableAnalytics.trackEvent === 'function') {
            scope.ALPlayableAnalytics.trackEvent(eventName);
        }
    }

    /** Compatibility for any scene/button code that still uses the component instance. */
    public dispatchEvent(eventName: analyticsEvents) {
        Analytics.trackEvent(eventName);
    }
}
