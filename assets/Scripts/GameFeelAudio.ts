/**
 * Lightweight Web Audio layers for tactile playable-ad feedback.
 * No scene component or Inspector setup is required, and sound is unlocked only
 * from player input. Unsupported runtimes fail silently.
 */
type AudioVoice = {
    source: any;
    gain: any;
};

export class GameFeelAudio {
    private static context: any = null;
    private static master: any = null;
    private static visibilityHooked = false;
    private static dragVoices: { [id: string]: AudioVoice } = Object.create(null);
    private static gateVoices: { [id: string]: AudioVoice } = Object.create(null);

    static startDrag(id: string) {
        const context = this.ensureContext();
        if (!context || !this.master) return;
        this.stopDrag(id);

        const source = context.createBufferSource();
        source.buffer = this.noiseBuffer(context, 0.24);
        source.loop = true;

        const filter = context.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 420;
        filter.Q.value = 0.65;

        const gain = context.createGain();
        gain.gain.setValueAtTime(0.0001, context.currentTime);
        gain.gain.linearRampToValueAtTime(0.0022, context.currentTime + 0.05);

        source.connect(filter);
        filter.connect(gain);
        gain.connect(this.master);
        source.start();
        this.dragVoices[id] = { source, gain };
    }

    static updateDrag(id: string, planarDistance: number) {
        const voice = this.dragVoices[id];
        const context = this.context;
        if (!voice || !context) return;
        const amount = Math.max(0, Math.min(1, planarDistance / 0.32));
        const target = 0.0015 + amount * 0.0065;
        voice.gain.gain.setTargetAtTime(target, context.currentTime, 0.028);
    }

    static stopDrag(id: string) {
        const voice = this.dragVoices[id];
        const context = this.context;
        if (!voice || !context) return;
        delete this.dragVoices[id];
        const now = context.currentTime;
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), now);
        voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);
        try { voice.source.stop(now + 0.065); } catch (_) { /* already stopped */ }
    }

    static setGateHum(id: string, active: boolean) {
        if (!active) {
            this.stopGateHum(id);
            return;
        }
        if (this.gateVoices[id]) return;
        const context = this.ensureContext();
        if (!context || !this.master) return;

        const source = context.createOscillator();
        source.type = 'sine';
        source.frequency.value = 92;
        const gain = context.createGain();
        gain.gain.setValueAtTime(0.0001, context.currentTime);
        gain.gain.linearRampToValueAtTime(0.0042, context.currentTime + 0.14);
        source.connect(gain);
        gain.connect(this.master);
        source.start();
        this.gateVoices[id] = { source, gain };
    }

    static stopGateHum(id: string) {
        const voice = this.gateVoices[id];
        const context = this.context;
        if (!voice || !context) return;
        delete this.gateVoices[id];
        const now = context.currentTime;
        voice.gain.gain.cancelScheduledValues(now);
        voice.gain.gain.setValueAtTime(Math.max(0.0001, voice.gain.gain.value), now);
        voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
        try { voice.source.stop(now + 0.09); } catch (_) { /* already stopped */ }
    }

    /** Low compact impact under the authored crush clip, followed by tiny chip ticks. */
    static playCrushAndChips() {
        const context = this.ensureContext();
        if (!context || !this.master) return;
        const now = context.currentTime;

        const body = context.createOscillator();
        body.type = 'triangle';
        body.frequency.setValueAtTime(78, now);
        body.frequency.exponentialRampToValueAtTime(42, now + 0.105);
        const bodyGain = context.createGain();
        bodyGain.gain.setValueAtTime(0.025, now);
        bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);
        body.connect(bodyGain);
        bodyGain.connect(this.master);
        body.start(now);
        body.stop(now + 0.12);

        const grit = context.createBufferSource();
        grit.buffer = this.noiseBuffer(context, 0.10);
        const gritFilter = context.createBiquadFilter();
        gritFilter.type = 'bandpass';
        gritFilter.frequency.value = 560;
        gritFilter.Q.value = 0.8;
        const gritGain = context.createGain();
        gritGain.gain.setValueAtTime(0.018, now);
        gritGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.095);
        grit.connect(gritFilter);
        gritFilter.connect(gritGain);
        gritGain.connect(this.master);
        grit.start(now);
        grit.stop(now + 0.105);

        const delays = [0.018, 0.052, 0.088, 0.126];
        for (let index = 0; index < delays.length; index++) {
            const start = now + delays[index];
            const chip = context.createOscillator();
            chip.type = 'triangle';
            chip.frequency.value = 980 + index * 170;
            const chipGain = context.createGain();
            chipGain.gain.setValueAtTime(0.0055 - index * 0.00065, start);
            chipGain.gain.exponentialRampToValueAtTime(0.0001, start + 0.026);
            chip.connect(chipGain);
            chipGain.connect(this.master);
            chip.start(start);
            chip.stop(start + 0.03);
        }
    }

    private static ensureContext() {
        const scope = globalThis as any;
        const Context = scope.AudioContext || scope.webkitAudioContext;
        if (!Context) return null;
        if (!this.context) {
            try {
                this.context = new Context();
                this.master = this.context.createGain();
                this.master.gain.value = 0.72;
                this.master.connect(this.context.destination);
                this.hookVisibility(scope);
            } catch (_) {
                this.context = null;
                this.master = null;
                return null;
            }
        }
        if (this.context.state === 'suspended') {
            const resume = this.context.resume();
            if (resume && typeof resume.catch === 'function') resume.catch(() => undefined);
        }
        return this.context;
    }

    private static noiseBuffer(context: any, seconds: number) {
        const length = Math.max(1, Math.floor(context.sampleRate * seconds));
        const buffer = context.createBuffer(1, length, context.sampleRate);
        const data = buffer.getChannelData(0);
        for (let index = 0; index < length; index++) {
            const envelope = 1 - index / length;
            data[index] = (Math.random() * 2 - 1) * (0.55 + envelope * 0.45);
        }
        return buffer;
    }

    private static hookVisibility(scope: any) {
        if (this.visibilityHooked || !scope.document) return;
        this.visibilityHooked = true;
        scope.document.addEventListener('visibilitychange', () => {
            if (!scope.document.hidden) return;
            for (const id of Object.keys(this.dragVoices)) this.stopDrag(id);
            for (const id of Object.keys(this.gateVoices)) this.stopGateHum(id);
            if (this.context?.state === 'running') this.context.suspend();
        });
    }
}
