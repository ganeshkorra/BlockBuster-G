import {
    _decorator, BoxCollider, Color, Component, Material, Mesh, MeshRenderer, Node,
    RigidBody, Tween, tween, utils, primitives, Vec3,
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
    private footprint: Node | null = null;
    private static footprintMesh: Mesh | null = null;
    private static footprintMaterial: Material | null = null;

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
        this.createFootprint();
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
        this.moveFootprint(position);
    }

    endDrag() {
        if (!this.dragging || this.consuming) return;
        this.dragging = false;
        this.removeFootprint();
        GameFeelAudio.stopDrag(this.node.uuid);
        Tween.stopAllByTarget(this.node);
        tween(this.node).to(0.10, { scale: this.homeScale.clone() }, { easing: 'quadOut' }).start();
    }

    /**
     * Sends the intact piece through the gate in one authored direction.
     * The caller supplies an exit with the lateral coordinate preserved, so this
     * never makes the piece jump sideways to the centre of a shredder.
     */
    consumeThrough(exitWorld: Readonly<Vec3>, duration: number, onImpact: () => void) {
        if (this.consuming) return;
        this.consuming = true;
        this.dragging = false;
        this.removeFootprint();
        GameFeelAudio.stopDrag(this.node.uuid);
        this.stopBody();
        // Stop an unfinished pickup-scale tween without changing the current
        // scale. The intact block therefore enters with no release-time pop.
        Tween.stopAllByTarget(this.node);

        const start = this.node.worldPosition.clone();
        const end = new Vec3(exitWorld.x, exitWorld.y, exitWorld.z);
        const alongX = Math.abs(end.x - start.x) > Math.abs(end.z - start.z);
        const motion = { t: 0 };
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
                },
            })
            .call(onImpact)
            .start();
    }

    /** Compatibility path for an already-running preview using the previous GameManager bundle. */
    consume(impactDelay: number, onImpact: () => void) {
        if (this.consuming) return;
        this.consuming = true;
        this.dragging = false;
        this.removeFootprint();
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

    /** A single soft contact footprint follows the held piece; it is not a dotted trail. */
    private createFootprint() {
        this.removeFootprint();
        const parent = this.node.parent;
        if (!parent) return;
        if (!Block.footprintMesh) Block.footprintMesh = utils.createMesh(primitives.box());

        const footprint = new Node('RuntimeDragFootprint');
        parent.addChild(footprint);
        this.footprint = footprint;
        this.moveFootprint(this.node.worldPosition);
        const collider = this.getComponent(BoxCollider);
        const width = collider ? collider.size.x * 1.035 : 1.96;
        const depth = collider ? collider.size.z * 1.035 : 1.96;
        const startScale = new Vec3(width, 0.008, depth);
        footprint.setScale(startScale);
        const renderer = footprint.addComponent(MeshRenderer);
        renderer.mesh = Block.footprintMesh;
        renderer.setMaterial(this.getFootprintMaterial(), 0);
        tween(footprint).to(0.10, { scale: new Vec3(width * 1.015, 0.008, depth * 1.015) }, { easing: 'sineOut' }).start();
    }

    private moveFootprint(position: Readonly<Vec3>) {
        if (!this.footprint || !this.footprint.isValid) return;
        this.footprint.setWorldPosition(new Vec3(position.x, position.y - 0.012, position.z));
    }

    private removeFootprint() {
        const footprint = this.footprint;
        this.footprint = null;
        if (!footprint || !footprint.isValid) return;
        const scale = footprint.scale.clone();
        tween(footprint)
            .to(0.10, { scale: new Vec3(scale.x * 0.94, 0.003, scale.z * 0.94) }, { easing: 'sineIn' })
            .call(() => { if (footprint.isValid) footprint.destroy(); })
            .start();
    }

    /** Independent transparent material: the shadow never edits the block material asset. */
    private getFootprintMaterial() {
        if (Block.footprintMaterial) return Block.footprintMaterial;
        const material = new Material();
        // builtin-unlit technique 1 is the transparent pass in Cocos 3.8.
        material.initialize({ effectName: 'builtin-unlit', technique: 1 });
        material.setProperty('mainColor', new Color(4, 12, 35, 44));
        Block.footprintMaterial = material;
        return material;
    }
}
