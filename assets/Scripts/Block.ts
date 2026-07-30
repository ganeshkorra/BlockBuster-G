import { _decorator, Component, Material, MeshRenderer, RigidBody, tween, Vec3 } from 'cc';

const { ccclass } = _decorator;

/**
 * Behaviour owned by one draggable puzzle block.
 * GameManager decides whether a destination is legal; this component owns
 * drag state, the visual hold feedback, rigidbody safety, and consumption.
 */
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
        if (this.consuming || this.dragging) return false;
        this.dragging = true;
        this.homeScale.set(this.node.scale);
        if (this.body) {
            this.body.useGravity = false;
            this.body.setLinearVelocity(Vec3.ZERO);
            this.body.setAngularVelocity(Vec3.ZERO);
        }
        this.node.setScale(this.node.scale.clone().multiplyScalar(1.04));
        return true;
    }

    moveTo(position: Readonly<Vec3>) {
        if (!this.dragging || this.consuming) return;
        this.node.setWorldPosition(position);
    }

    endDrag() {
        if (!this.dragging) return;
        this.dragging = false;
        tween(this.node).to(0.08, { scale: this.homeScale.clone() }).start();
    }

    /** Keeps the existing solid-block-until-impact crush timing. */
    consume(impactDelay: number, onImpact: () => void) {
        if (this.consuming) return;
        this.consuming = true;
        this.dragging = false;
        if (this.body) {
            this.body.useGravity = false;
            this.body.setLinearVelocity(Vec3.ZERO);
            this.body.setAngularVelocity(Vec3.ZERO);
        }
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
}
