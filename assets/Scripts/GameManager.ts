import {
    _decorator, BoxCollider, Camera, Color, Component, EventTouch, find, geometry, Input, input,
    Material, MeshRenderer, Node, PhysicsSystem, RigidBody, Tween, tween, Vec3,
} from 'cc';
import { Block } from './Block';
import { Shredder } from './Shredder';

const { ccclass, property } = _decorator;

type Bounds3D = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };

/** One independently configurable colour/type. Its node arrays are the level authoring interface. */
@ccclass('GameElement')
export class GameElement {
    @property({ tooltip: 'Unique stable ID, e.g. White or Black.' })
    elementId = '';

    @property({ type: [Node], tooltip: 'Exact draggable blocks for this element.' })
    blockNodes: Node[] = [];

    @property({ type: [Node], tooltip: 'Matching shredder goal slots for this element.' })
    targetShredders: Node[] = [];
}

/** Input, board legality, gate routing, and global game-feel feedback. */
@ccclass('GameManager')
export class GameManager extends Component {
    @property({ type: Camera, tooltip: 'The board camera.' })
    camera: Camera | null = null;

    @property({ type: [GameElement], tooltip: 'Add one Element for each block colour/type in a level.' })
    elements: GameElement[] = [];

    private blocks: Node[] = [];
    private boardPhysical: Node | null = null;
    private grabbed: Node | null = null;
    private anticipated: Shredder | null = null;
    private isCrushing = false;
    private dragHeight = 0;

    start() {
        this.camera = this.camera || find('Main Camera')?.getComponent(Camera) || null;
        this.refreshSceneReferences();
        input.on(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.on(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.on(Input.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
    }

    onDestroy() {
        input.off(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.off(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
    }

    /** Rebuilds runtime state exclusively from the Elements inspector arrays. */
    refreshSceneReferences() {
        this.boardPhysical = this.node.parent ? this.findDescendant(this.node.parent, 'BoardPhysical') : null;
        this.blocks = [];
        for (const element of this.elements) {
            for (const block of element.blockNodes) {
                if (block && block.isValid && this.blocks.indexOf(block) === -1) this.blocks.push(block);
            }
        }
        for (const block of this.blocks) {
            const body = block.getComponent(RigidBody);
            if (body) body.useGravity = false;
        }
        if (!this.boardPhysical || this.blocks.length === 0) console.warn('[GameManager] Add BoardPhysical and Element block references.');
    }

    private onTouchStart(event: EventTouch) {
        if (this.isCrushing || this.grabbed) return;
        const block = this.pickBlock(event);
        const behaviour = block?.getComponent(Block) || null;
        if (!block || !behaviour || !behaviour.beginDrag()) return;
        this.grabbed = block;
        this.dragHeight = block.worldPosition.y;
    }

    private onTouchMove(event: EventTouch) {
        const block = this.grabbed;
        if (!block) return;
        const target = this.pointOnDragPlane(event);
        this.keepInsideBoardColliders(block, target);
        if (!this.canPlaceWithoutOverlap(block, target)) return;

        block.getComponent(Block)?.moveTo(target);
        this.updateGateAnticipation(block);
        const shredder = this.matchingShredderDrop(block);
        if (shredder) {
            this.grabbed = null;
            this.crush(block, shredder);
        }
    }

    private onTouchEnd() {
        const block = this.grabbed;
        if (!block) return;
        this.grabbed = null;
        this.clearGateAnticipation();
        const shredder = this.matchingShredderDrop(block);
        if (shredder) this.crush(block, shredder);
        else block.getComponent(Block)?.endDrag();
    }

    private onTouchCancel() { this.onTouchEnd(); }

    private crush(block: Node, shredderNode: Node) {
        if (this.isCrushing || !block.isValid) return;
        const blockBehaviour = block.getComponent(Block);
        const shredder = shredderNode.getComponent(Shredder);
        if (!blockBehaviour || !shredder) return;

        this.isCrushing = true;
        this.clearGateAnticipation();
        const exit = this.shredderExitWorld(block, shredderNode);
        const direction = this.shredderExitNormal(block, shredderNode);

        // The block stays intact while it travels outward. The exit calculation
        // retains its lateral coordinate, eliminating the old centre/left snap.
        blockBehaviour.consumeThrough(exit, 0.18, () => {
            shredder.playCrushFeedback(blockBehaviour, exit, direction);
            this.playCameraImpact(direction);
            this.blocks = this.blocks.filter((entry) => entry !== block);
            block.destroy();
            this.isCrushing = false;
        });
    }

    /** Highlights only a matching gate that is close to the held piece. */
    private updateGateAnticipation(block: Node) {
        let nearest: Shredder | null = null;
        let nearestDistance = Number.POSITIVE_INFINITY;
        for (const gateNode of this.targetsFor(block)) {
            const gate = gateNode.getComponent(Shredder);
            if (!gate) continue;
            const distance = this.distanceToDropArea(block, gateNode);
            if (distance < 1.35 && distance < nearestDistance) {
                nearest = gate;
                nearestDistance = distance;
            }
        }
        if (nearest === this.anticipated) return;
        this.clearGateAnticipation();
        if (nearest) {
            nearest.setAnticipation(true, this.blockMainColour(block));
            this.anticipated = nearest;
        }
    }

    private clearGateAnticipation() {
        if (!this.anticipated) return;
        this.anticipated.setAnticipation(false, null);
        this.anticipated = null;
    }

    private distanceToDropArea(block: Node, shredder: Node) {
        const point = block.worldPosition;
        let best = Number.POSITIVE_INFINITY;
        const gate = shredder.getComponent(Shredder);
        for (const collider of gate?.dropColliders() || this.allBoxColliders(shredder)) {
            const bounds = this.worldBounds(collider);
            const dx = Math.max(bounds.minX - point.x, 0, point.x - bounds.maxX);
            const dz = Math.max(bounds.minZ - point.z, 0, point.z - bounds.maxZ);
            best = Math.min(best, Math.sqrt(dx * dx + dz * dz));
        }
        return best;
    }

    private matchingShredderDrop(block: Node): Node | null {
        for (const target of this.targetsFor(block)) {
            const shredder = target.getComponent(Shredder);
            const blockBehaviour = block.getComponent(Block);
            if (shredder && blockBehaviour && shredder.matches(blockBehaviour) && this.overlapsShredderTrigger(block, target)) return target;
        }
        return null;
    }

    private targetsFor(block: Node): Node[] {
        for (const element of this.elements) {
            if (element.blockNodes.indexOf(block) !== -1) return element.targetShredders.filter((node) => !!node && node.isValid);
        }
        return [];
    }

    private pickBlock(event: EventTouch): Node | null {
        if (!this.camera) return null;
        const ray = new geometry.Ray();
        this.camera.screenPointToRay(event.getLocationX(), event.getLocationY(), ray);
        if (PhysicsSystem.instance.raycastClosest(ray)) {
            let hit: Node | null = PhysicsSystem.instance.raycastClosestResult.collider.node;
            while (hit) {
                if (this.blocks.indexOf(hit) !== -1) return hit;
                hit = hit.parent;
            }
        }
        // Controlled fallback for a prefab collider disabled by an override.
        const point = this.pointOnDragPlane(event);
        let candidate: Node | null = null;
        let best = 2.25 * 2.25;
        for (const block of this.blocks) {
            const position = block.worldPosition;
            const dx = position.x - point.x;
            const dz = position.z - point.z;
            const distance = dx * dx + dz * dz;
            if (distance < best) { best = distance; candidate = block; }
        }
        return candidate;
    }

    private pointOnDragPlane(event: EventTouch) {
        const ray = new geometry.Ray();
        this.camera!.screenPointToRay(event.getLocationX(), event.getLocationY(), ray);
        if (Math.abs(ray.d.y) < 0.0001) return new Vec3();
        const t = (this.dragHeight - ray.o.y) / ray.d.y;
        return new Vec3(ray.o.x + ray.d.x * t, this.dragHeight, ray.o.z + ray.d.z * t);
    }

    private overlapsShredderTrigger(block: Node, shredder: Node) {
        const gate = shredder.getComponent(Shredder);
        const targets = gate?.dropColliders() || this.allBoxColliders(shredder);
        for (const blockCollider of this.allBoxColliders(block)) {
            for (const targetCollider of targets) {
                if (this.boundsIntersect(this.worldBounds(blockCollider), this.worldBounds(targetCollider))) return true;
            }
        }
        return false;
    }

    /** Board walls, not hard-coded dimensions, define the playable area. */
    private keepInsideBoardColliders(block: Node, target: Vec3) {
        const board = this.readBoardInterior();
        if (!board) return;
        const rects = this.colliderRects(block, target);
        const minX = Math.min(...rects.map((rect) => rect.minX));
        const maxX = Math.max(...rects.map((rect) => rect.maxX));
        const minZ = Math.min(...rects.map((rect) => rect.minZ));
        const maxZ = Math.max(...rects.map((rect) => rect.maxZ));
        if (minX < board.minX) target.x += board.minX - minX;
        if (maxX > board.maxX) target.x -= maxX - board.maxX;
        if (minZ < board.minZ) target.z += board.minZ - minZ;
        if (maxZ > board.maxZ) target.z -= maxZ - board.maxZ;
    }

    private canPlaceWithoutOverlap(dragged: Node, target: Readonly<Vec3>) {
        const draggingRects = this.colliderRects(dragged, target);
        for (const other of this.blocks) {
            if (other === dragged || !other.isValid) continue;
            for (const current of draggingRects) {
                for (const occupied of this.colliderRects(other, other.worldPosition)) {
                    if (this.rectanglesOverlap(current, occupied)) return false;
                }
            }
        }
        return true;
    }

    private readBoardInterior(): Rect | null {
        if (!this.boardPhysical) return null;
        let minX = Number.NEGATIVE_INFINITY, maxX = Number.POSITIVE_INFINITY;
        let minZ = Number.NEGATIVE_INFINITY, maxZ = Number.POSITIVE_INFINITY;
        let xWalls = false, zWalls = false;
        const origin = this.boardPhysical.worldPosition;
        const scale = this.boardPhysical.worldScale;
        for (const wall of this.boardPhysical.getComponents(BoxCollider)) {
            const centerX = origin.x + wall.center.x * scale.x;
            const centerZ = origin.z + wall.center.z * scale.z;
            const halfX = Math.abs(wall.size.x * scale.x) * 0.5;
            const halfZ = Math.abs(wall.size.z * scale.z) * 0.5;
            if (halfX < halfZ) {
                xWalls = true;
                if (centerX < origin.x) minX = Math.max(minX, centerX + halfX);
                else maxX = Math.min(maxX, centerX - halfX);
            } else {
                zWalls = true;
                if (centerZ < origin.z) minZ = Math.max(minZ, centerZ + halfZ);
                else maxZ = Math.min(maxZ, centerZ - halfZ);
            }
        }
        return xWalls && zWalls ? { minX, maxX, minZ, maxZ } : null;
    }

    private colliderRects(root: Node, rootPosition: Readonly<Vec3>): Rect[] {
        const colliders = root.getComponents(BoxCollider);
        if (colliders.length === 0) return [{ minX: rootPosition.x - 0.9, maxX: rootPosition.x + 0.9, minZ: rootPosition.z - 0.9, maxZ: rootPosition.z + 0.9 }];
        const delta = new Vec3();
        Vec3.subtract(delta, rootPosition, root.worldPosition);
        return colliders.map((collider) => {
            const scale = collider.node.worldScale;
            const position = collider.node.worldPosition;
            const halfX = Math.abs(collider.size.x * scale.x) * 0.5 + 0.03;
            const halfZ = Math.abs(collider.size.z * scale.z) * 0.5 + 0.03;
            const centerX = position.x + collider.center.x * scale.x + delta.x;
            const centerZ = position.z + collider.center.z * scale.z + delta.z;
            return { minX: centerX - halfX, maxX: centerX + halfX, minZ: centerZ - halfZ, maxZ: centerZ + halfZ };
        });
    }

    private shredderExitNormal(block: Node, shredder: Node) {
        const collider = this.shredderRootCollider(shredder);
        if (!collider) return new Vec3(0, 0, 1);
        const bounds = this.worldBounds(collider);
        const center = this.boardPhysical?.worldPosition || Vec3.ZERO;
        return (bounds.maxX - bounds.minX >= bounds.maxZ - bounds.minZ)
            ? new Vec3(0, 0, block.worldPosition.z >= center.z ? 1 : -1)
            : new Vec3(block.worldPosition.x >= center.x ? 1 : -1, 0, 0);
    }

    private shredderExitWorld(block: Node, shredder: Node) {
        const collider = this.shredderRootCollider(shredder);
        if (!collider) return shredder.worldPosition.clone();
        const bounds = this.worldBounds(collider);
        const exit = block.worldPosition.clone();
        const normal = this.shredderExitNormal(block, shredder);
        if (Math.abs(normal.z) > 0) exit.z = normal.z > 0 ? bounds.maxZ + this.blockHalfExtent(block, 'z') : bounds.minZ - this.blockHalfExtent(block, 'z');
        else exit.x = normal.x > 0 ? bounds.maxX + this.blockHalfExtent(block, 'x') : bounds.minX - this.blockHalfExtent(block, 'x');
        return exit;
    }

    private playCameraImpact(direction: Readonly<Vec3>) {
        if (!this.camera?.node?.isValid) return;
        const node = this.camera.node;
        const home = node.worldPosition.clone();
        const lateral = new Vec3(-direction.z, 0, direction.x);
        const state = { t: 0 };
        Tween.stopAllByTarget(state);
        tween(state)
            .to(0.045, { t: 1 }, {
                easing: 'quadOut',
                onUpdate: () => node.setWorldPosition(new Vec3(home.x - direction.x * 0.075 + lateral.x * 0.028, home.y, home.z - direction.z * 0.075 + lateral.z * 0.028)),
            })
            .to(0.14, { t: 0 }, {
                easing: 'quadInOut',
                onUpdate: () => node.setWorldPosition(new Vec3(home.x - direction.x * 0.075 * state.t + lateral.x * 0.028 * state.t, home.y, home.z - direction.z * 0.075 * state.t + lateral.z * 0.028 * state.t)),
            })
            .call(() => { if (node.isValid) node.setWorldPosition(home); })
            .start();
    }

    private blockHalfExtent(block: Node, axis: 'x' | 'z') {
        const colliders = this.allBoxColliders(block);
        if (colliders.length === 0) return 0.5;
        let min = Number.POSITIVE_INFINITY, max = Number.NEGATIVE_INFINITY;
        for (const collider of colliders) {
            const bounds = this.worldBounds(collider);
            min = Math.min(min, axis === 'x' ? bounds.minX : bounds.minZ);
            max = Math.max(max, axis === 'x' ? bounds.maxX : bounds.maxZ);
        }
        return Math.max(0.1, (max - min) * 0.5);
    }

    private shredderRootCollider(shredder: Node) {
        return this.allBoxColliders(shredder).find((collider) => collider.node === shredder && !collider.isTrigger) || null;
    }

    private allBoxColliders(root: Node) {
        const result: BoxCollider[] = [];
        const visit = (node: Node) => {
            result.push(...node.getComponents(BoxCollider));
            for (const child of node.children) visit(child);
        };
        visit(root);
        return result;
    }

    private worldBounds(collider: BoxCollider): Bounds3D {
        const scale = collider.node.worldScale;
        const position = collider.node.worldPosition;
        const center = new Vec3(position.x + collider.center.x * scale.x, position.y + collider.center.y * scale.y, position.z + collider.center.z * scale.z);
        const half = new Vec3(Math.abs(collider.size.x * scale.x) * 0.5, Math.abs(collider.size.y * scale.y) * 0.5, Math.abs(collider.size.z * scale.z) * 0.5);
        return { minX: center.x - half.x, maxX: center.x + half.x, minY: center.y - half.y, maxY: center.y + half.y, minZ: center.z - half.z, maxZ: center.z + half.z };
    }

    private boundsIntersect(a: Bounds3D, b: Bounds3D) {
        return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY && a.minZ < b.maxZ && a.maxZ > b.minZ;
    }

    private rectanglesOverlap(a: Rect, b: Rect) {
        return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
    }

    private blockMainColour(block: Node): Color | null {
        for (const material of this.sharedMaterials(block)) {
            const value = material.getProperty('mainColor') as Color | null;
            if (value && typeof value.r === 'number') return new Color(value.r, value.g, value.b, value.a);
        }
        return null;
    }

    private sharedMaterials(root: Node): Material[] {
        const materials: Material[] = [];
        for (const renderer of root.getComponentsInChildren(MeshRenderer)) {
            for (let index = 0; index < renderer.sharedMaterials.length; index++) {
                const material = renderer.getSharedMaterial(index);
                if (material) materials.push(material);
            }
        }
        return materials;
    }

    private findDescendant(root: Node, name: string): Node | null {
        if (root.name === name) return root;
        for (const child of root.children) {
            const match = this.findDescendant(child, name);
            if (match) return match;
        }
        return null;
    }
}
