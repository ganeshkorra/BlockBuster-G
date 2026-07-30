import {
    _decorator, Component, Material, MeshRenderer, RigidBody, Tween, tween, Vec3,
} from 'cc';
import { GameFeelAudio } from './GameFeelAudio';

const { ccclass } = _decorator;

/** Runtime behaviour for one draggable puzzle block. */
@ccclass('Block')
export class Block extends Component {
    private body: RigidBody | null = null;
    private homeScale = new Vec3(1, 1, 1);
    private dragging = false;
    private consuming = false;

    onLoad() {
        this.body = this.getComponent(RigidBody);
        if (this.body) this.body.useGravity = false;
    }

    get isDragging() { return this.dragging; }
    get isConsuming() { return this.consuming; }

    beginDrag(): boolean {
        if (this.dragging || this.consuming) return false;
        this.dragging = true;
        this.homeScale.set(this.node.scale);
        this.stopBody();
        Tween.stopAllByTarget(this.node);
        GameFeelAudio.startDrag(this.node.uuid);
        // A restrained lift: enough to separate the piece from its board shadow,
        // without the pop/bounce that makes the reference interaction feel cheap.
        tween(this.node).to(0.07, { scale: this.homeScale.clone().multiplyScalar(1.025) }, { easing: 'quadOut' }).start();
        return true;
    }

    moveTo(position: Readonly<Vec3>) {
        if (!this.dragging || this.consuming) return;
        const current = this.node.worldPosition;
        const dx = position.x - current.x;
        const dz = position.z - current.z;
        GameFeelAudio.updateDrag(this.node.uuid, Math.sqrt(dx * dx + dz * dz));
        this.node.setWorldPosition(position);
    }

    endDrag() {
        if (!this.dragging || this.consuming) return;
        this.dragging = false;
        GameFeelAudio.stopDrag(this.node.uuid);
        Tween.stopAllByTarget(this.node);
        tween(this.node).to(0.10, { scale: this.homeScale.clone() }, { easing: 'quadOut' }).start();
    }

    /**
     * Sends the intact piece through the gate in one authored direction.
     * The caller supplies an exit with the lateral coordinate preserved, so this
     * never makes the piece jump sideways to the centre of a shredder.
     */
    consumeThrough(
        exitWorld: Readonly<Vec3>,
        duration: number,
        onTwentyPercentEntry: () => void,
        onComplete: () => void,
    ) {
        if (this.consuming) return;
        this.consuming = true;
        this.dragging = false;
        GameFeelAudio.stopDrag(this.node.uuid);
        this.stopBody();
        // Stop an unfinished pickup-scale tween without changing the current
        // scale. The intact block therefore enters with no release-time pop.
        Tween.stopAllByTarget(this.node);

        const start = this.node.worldPosition.clone();
        const end = new Vec3(exitWorld.x, exitWorld.y, exitWorld.z);
        const alongX = Math.abs(end.x - start.x) > Math.abs(end.z - start.z);
        const crushStartScale = this.node.scale.clone();
        const renderers = this.getComponentsInChildren(MeshRenderer);
        const motion = { t: 0 };
        let entryFeedbackPlayed = false;
        tween(motion)
            .to(duration, { t: 1 }, {
                easing: 'sineIn',
                onUpdate: () => {
                    // Change only the outward axis. Lateral position and height
                    // remain exactly as released throughout the entire intake.
                    const position = start.clone();
                    if (alongX) position.x = start.x + (end.x - start.x) * motion.t;
                    else position.z = start.z + (end.z - start.z) * motion.t;
                    this.node.setWorldPosition(position);

                    if (!entryFeedbackPlayed && motion.t >= 0.20) {
                        entryFeedbackPlayed = true;
                        onTwentyPercentEntry();
                    }

                    // From 20% to 60% intake, compress the visible block into the
                    // shredder slit. It is fully hidden before its transform moves
                    // outside, while the authored cube particles replace it.
                    if (motion.t >= 0.20) {
                        const crushProgress = Math.min(1, (motion.t - 0.20) / 0.40);
                        const eased = 1 - (1 - crushProgress) * (1 - crushProgress);
                        const scale = crushStartScale.clone();
                        if (alongX) scale.x *= 1 - eased * 0.98;
                        else scale.z *= 1 - eased * 0.98;
                        scale.y *= 1 - eased * 0.85;
                        if (alongX) scale.z *= 1 - eased * 0.08;
                        else scale.x *= 1 - eased * 0.08;
                        this.node.setScale(scale);
                        if (crushProgress >= 1) {
                            for (const renderer of renderers) renderer.enabled = false;
                        }
                    }
                },
            })
            .call(() => {
                // Extremely short/paused frames can skip an update callback.
                if (!entryFeedbackPlayed) onTwentyPercentEntry();
                onComplete();
            })
            .start();
    }

    /** Compatibility path for an already-running preview using the previous GameManager bundle. */
    consume(impactDelay: number, onImpact: () => void) {
        if (this.consuming) return;
        this.consuming = true;
        this.dragging = false;
        GameFeelAudio.stopDrag(this.node.uuid);
        this.stopBody();
        Tween.stopAllByTarget(this.node);
        tween(this.node).delay(impactDelay).call(onImpact).start();
    }

    sharedMaterials(): Material[] {
        const materials: Material[] = [];
        for (const renderer of this.getComponentsInChildren(MeshRenderer)) {
            for (let index = 0; index < renderer.sharedMaterials.length; index++) {
                const material = renderer.getSharedMaterial(index);
                if (material) materials.push(material);
            }
        }
        return materials;
    }

    onDestroy() {
        GameFeelAudio.stopDrag(this.node.uuid);
    }

    private stopBody() {
        if (!this.body) return;
        this.body.useGravity = false;
        this.body.setLinearVelocity(Vec3.ZERO);
        this.body.setAngularVelocity(Vec3.ZERO);
    }
}
