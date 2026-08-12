import { _decorator, AudioSource, CCString, Component, find, Node, sys } from 'cc';
import { Analytics, analyticsEvents } from './Analytics';
const { ccclass, property } = _decorator;

@ccclass('CTAButtonHandler')
export class CTAButtonHandler extends Component {
   @property({
    type: CCString,
    tooltip: 'Default Andriod Playstore URL'
   })

   public androidPlayStoreURL: string = 'https://play.google.com/store/apps/details?id=com.block.away';

   @property({
    type: CCString,
    tooltip: 'Default IOS Appstore URL'
   })
   public iosAppStoreURL: string = 'https://apps.apple.com/us/app/block-buster-no-timer/id6745272388';  

   private isMraidReady: boolean = false;


    onLoad() {
        const adWindow = globalThis as any;
        const mraid = adWindow.mraid;

        if (mraid) {
            if (mraid.getState && mraid.getState() === 'loading') {
                mraid.addEventListener('ready', this.onMraidReady.bind(this));
            }else {
                this.onMraidReady();
            } 
        }else {
        }
    }

             private onMraidReady(): void {
        this.isMraidReady = true;
    }


     /**
     * Helper to get the correct URL based on Device OS
     */
    private getTargetStoreUrl(): string {
        if (sys.os === sys.OS.IOS) {
            return this.iosAppStoreURL;
        } else {
            // Default to Android for Android devices, Desktop browsers, and others
            return this.androidPlayStoreURL;
        }
    }

    /**
     * Linked to the CTA button's click event in the Cocos Inspector
     */
    public onStoreButtonClicked(): void {
        const targetUrl = this.getTargetStoreUrl();

        // Fire CTA_CLICKED event
        if (Analytics.instance) {
            Analytics.instance.dispatchEvent(analyticsEvents.CTA_CLICKED);
        }

        // 1. Stop audio before redirecting (Technical requirement)
        const mainAudio =
            find("Canvas-001/GameCamera")?.getComponent(AudioSource) ||
            find("Canvas/Camera")?.getComponent(AudioSource);
        if (mainAudio) {
            mainAudio.stop();
        }

        const adWindow = globalThis as any;
        const exitApi = adWindow.ExitApi;
        const superHtml = adWindow.super_html;
        const mraid = adWindow.mraid;

        // 2. Google playable ads require ExitApi.exit() for clickthroughs.
        if (exitApi && typeof exitApi.exit === "function") {
            exitApi.exit();
            return;
        }

        // 3. Super HTML's Google wrapper also routes download() to ExitApi.exit().
        if (superHtml && typeof superHtml.download === "function") {
            superHtml.download(targetUrl);
            return;
        }

        // 4. Redirect using MRAID if available
        if (mraid && typeof mraid.open === "function") {
            mraid.open(targetUrl);
        } 
        // 5. Browser fallback for local/custom environments that do not expose an ad SDK.
        else {
            adWindow.open(targetUrl, "_blank");
        }
    }
}


