import {
    _decorator, BoxCollider, Color, Component, Material, Mesh, MeshRenderer, Node, RigidBody, Tween, tween, utils, Vec3,
} from 'cc';
import { GameFeelAudio } from './GameFeelAudio';

const { ccclass } = _decorator;

/** Runtime behaviour for one draggable puzzle block. */
@ccclass('Block')
export class Block extends Component {
    private static footprintMesh: Mesh | null = null;
    private body: RigidBody | null = null;
    private homeScale = new Vec3(1, 1, 1);
    private dragging = false;
    private consuming = false;
    private dragTarget: Vec3 | null = null;
    private dragBaseY = 0;
    private readonly dragLift = 0.28;
    private footprintTiles: Node[] = [];
    private footprintMaterial: Material | null = null;
    private footprintPulse = { alpha: 0 };

    onLoad() {
        this.body = this.getComponent(RigidBody);
        if (this.body) this.body.useGravity = false;
    }

    get isDragging() { return this.dragging; }
    get isConsuming() { return this.consuming; }

    beginDrag(): boolean {
        if (this.dragging || this.consuming) return false;
        this.dragging = true;
        this.dragBaseY = this.node.worldPosition.y;
        this.dragTarget = this.node.worldPosition.clone();
        this.showFootprint(true);
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
        // Lift the held block above its board cells so the placement footprint
        // is visible underneath, as in the reference interaction.
        this.dragTarget = new Vec3(position.x, this.dragBaseY + this.dragLift, position.z);
    }

    update(deltaTime: number) {
        if (!this.dragging || !this.dragTarget || this.consuming) return;
        // Frame-rate-independent smoothing: the block catches up quickly but
        // never jerks between uneven touch-move events.
        const follow = 1 - Math.exp(-24 * deltaTime);
        const next = new Vec3();
        Vec3.lerp(next, this.node.worldPosition, this.dragTarget, follow);
        this.node.setWorldPosition(next);
        this.updateFootprintTiles();
    }

    /** Snaps to the latest legal drag target before a release is evaluated. */
    settleDrag() {
        if (!this.dragTarget || this.consuming) return;
        // Drop to board height before the gate-overlap calculation.
        this.node.setWorldPosition(new Vec3(this.dragTarget.x, this.dragBaseY, this.dragTarget.z));
    }

    endDrag() {
        if (!this.dragging || this.consuming) return;
        this.dragging = false;
        this.dragTarget = null;
        this.showFootprint(false);
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
        this.dragTarget = null;
        this.showFootprint(false);
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
        this.dragTarget = null;
        this.showFootprint(false);
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
        Tween.stopAllByTarget(this.footprintPulse);
        this.footprintMaterial?.destroy();
        this.footprintMaterial = null;
        for (const tile of this.footprintTiles) if (tile.isValid) tile.destroy();
        this.footprintTiles = [];
    }

    /** Glows the individual board cells occupied by the held block. */
    private showFootprint(visible: boolean) {
        this.ensureFootprint();
        if (this.footprintTiles.length === 0) return;
        Tween.stopAllByTarget(this.footprintPulse);
        if (!visible) {
            for (const tile of this.footprintTiles) tile.active = false;
            return;
        }
        this.updateFootprintTiles();
        this.footprintPulse.alpha = 0;
        this.applyFootprintAlpha();
        for (const tile of this.footprintTiles) tile.active = true;
        tween(this.footprintPulse)
            .to(0.16, { alpha: 235 }, { easing: 'sineInOut', onUpdate: () => this.applyFootprintAlpha() })
            .to(0.28, { alpha: 145 }, { easing: 'sineInOut', onUpdate: () => this.applyFootprintAlpha() })
            .union()
            .repeatForever()
            .start();
    }

    private ensureFootprint() {
        if (this.footprintTiles.length > 0) return;
        if (!Block.footprintMesh) {
            Block.footprintMesh = utils.createMesh({
                positions: [-1, 0, -1, 1, 0, -1, 1, 0, 1, -1, 0, 1],
                normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0],
                uvs: [0, 0, 1, 0, 1, 1, 0, 1],
                colors: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
                indices: [0, 2, 1, 0, 3, 2],
                minPos: new Vec3(-1, 0, -1),
                maxPos: new Vec3(1, 0, 1),
            });
        }
        const collider = this.getComponent(BoxCollider);
        const worldScale = this.node.worldScale;
        const width = (collider?.size.x || 1.9) * worldScale.x;
        const depth = (collider?.size.z || 1.9) * worldScale.z;
        const columns = Math.max(1, Math.round(width));
        const rows = Math.max(1, Math.round(depth));
        const material = new Material();
        material.initialize({ effectName: 'builtin-unlit', technique: 2 });
        material.recompileShaders({ USE_VERTEX_COLOR: true });
        this.footprintMaterial = material;
        const parent = this.node.parent || this.node;
        for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
                const tile = new Node('DragTileGlow');
                tile.layer = this.node.layer;
                parent.addChild(tile);
                // Each quad is just under one grid cell, so the dark seams
                // remain visible between glowing cells.
                tile.setScale(0.48, 1, 0.48);
                const renderer = tile.addComponent(MeshRenderer);
                renderer.mesh = Block.footprintMesh;
                renderer.setMaterial(material, 0);
                tile.active = false;
                this.footprintTiles.push(tile);
            }
        }
    }

    private applyFootprintAlpha() {
        this.footprintMaterial?.setProperty('mainColor', new Color(78, 212, 255, this.footprintPulse.alpha));
    }

    private updateFootprintTiles() {
        if (this.footprintTiles.length === 0) return;
        const collider = this.getComponent(BoxCollider);
        const scale = this.node.worldScale;
        const width = (collider?.size.x || 1.9) * scale.x;
        const depth = (collider?.size.z || 1.9) * scale.z;
        const columns = Math.max(1, Math.round(width));
        const rows = Math.max(1, Math.round(depth));
        const stepX = width / columns;
        const stepZ = depth / rows;
        const origin = this.node.worldPosition;
        let index = 0;
        for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
                const tile = this.footprintTiles[index++];
                tile.setWorldPosition(new Vec3(
                    origin.x - width * 0.5 + stepX * (column + 0.5),
                    // The board mesh sits above the block root origin, so the
                    // indicator must be raised into its visible surface layer.
                    // The block itself is lifted while dragging; glow cells
                    // remain fixed on the board directly below its footprint.
                    this.dragBaseY + 0.20,
                    origin.z - depth * 0.5 + stepZ * (row + 0.5),
                ));
            }
        }
    }

    private stopBody() {
        if (!this.body) return;
        this.body.useGravity = false;
        this.body.setLinearVelocity(Vec3.ZERO);
        this.body.setAngularVelocity(Vec3.ZERO);
    }
}
