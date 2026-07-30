import { _decorator, Component, Material, MeshRenderer, RigidBody, tween, Vec3 } from 'cc';

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
        // A restrained lift: enough to separate the piece from its board shadow,
        // without the pop/bounce that makes the reference interaction feel cheap.
        tween(this.node).to(0.07, { scale: this.homeScale.clone().multiplyScalar(1.025) }, { easing: 'quadOut' }).start();
        return true;
    }

    moveTo(position: Readonly<Vec3>) {
        if (!this.dragging || this.consuming) return;
        this.node.setWorldPosition(position);
    }

    endDrag() {
        if (!this.dragging || this.consuming) return;
        this.dragging = false;
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
        this.stopBody();

        const start = this.node.worldPosition.clone();
        const end = new Vec3(exitWorld.x, exitWorld.y, exitWorld.z);
        const motion = { t: 0 };
        tween(motion)
            .to(duration, { t: 1 }, {
                easing: 'sineIn',
                onUpdate: () => {
                    const position = new Vec3();
                    Vec3.lerp(position, start, end, motion.t);
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
        this.stopBody();
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

    private stopBody() {
        if (!this.body) return;
        this.body.useGravity = false;
        this.body.setLinearVelocity(Vec3.ZERO);
        this.body.setAngularVelocity(Vec3.ZERO);
    }
}
