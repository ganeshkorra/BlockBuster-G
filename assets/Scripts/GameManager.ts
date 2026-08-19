import {
    _decorator, Animation, AudioClip, AudioSource, BoxCollider, Camera, Color, Component, EventTouch, find,
    geometry, Input, input, instantiate, Material, MeshRenderer, Node, PhysicsSystem, RigidBody, Tween, tween, Vec3,
} from 'cc';
import { Block } from './Block';
import { Shredder } from './Shredder';
import { Analytics, analyticsEvents } from './Analytics';

const { ccclass, property } = _decorator;

type Bounds3D = { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
type Rect = { minX: number; maxX: number; minZ: number; maxZ: number };
type BoardShape = { outer: Rect; neck: Rect | null };
type GridCell = { column: number; row: number; x: number; z: number };

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

    @property({ type: Node, tooltip: 'Parent node containing tutorial hand children: Idle and Click.' })
    hand: Node | null = null;

    @property({ type: Node, tooltip: 'Call-to-action node shown when game time expires.' })
    cta: Node | null = null;

    @property({ type: AudioClip, tooltip: 'Looping background music. Playback begins on the first player touch.' })
    bgmClip: AudioClip | null = null;

    @property({ tooltip: 'Background music volume.' })
    bgmVolume = 0.28;

    @property({ type: AudioClip, tooltip: 'Short sound played when the player picks up a block.' })
    dragClip: AudioClip | null = null;

    @property({ tooltip: 'Block pickup sound volume.' })
    dragVolume = 0.65;

    @property({ tooltip: 'Fallback column count when a scene has no authored one-cell blocks.' })
    boardColumns = 7;

    @property({ tooltip: 'Fallback row count when a scene has no authored one-cell blocks.' })
    boardRows = 12;

    @property({ tooltip: 'Fallback spacing when grid centres cannot be derived from the scene.' })
    gridCellSize = 2;

    private blocks: Node[] = [];
    private boardPhysical: Node | null = null;
    private boardShape: BoardShape | null = null;
    private gridCells: GridCell[] = [];
    private gridUnitWidth = 0;
    private gridUnitDepth = 0;
    private grabbed: Node | null = null;
    private anticipated: Shredder | null = null;
    private isCrushing = false;
    private dragHeight = 0;
    /** Offset from the finger to the grabbed point on the block. */
    private dragOffset = new Vec3();
    /** Last displayed position whose complete collider did not overlap another block. */
    private lastLegalDragPosition: Vec3 | null = null;
    /** Grid position occupied before the current drag, used as a safe fallback. */
    private dragStartGridPosition: Vec3 | null = null;
    /** Keeps multi-cell pieces aligned to their authored grid phase. */
    private dragGridOffset = new Vec3();
    /** Use the complete authored collider; a positive inset permits visible penetration. */
    private readonly dragCollisionInset = 0;

    // Tutorial hand state
    private tutorialHandActive = false;
    private tutorialHandPulseFn: (() => void) | null = null;
    private yellowTutorialActive = false;
    private yellowTutorialBlock: Node | null = null;
    private yellowTutorialShredder: Node | null = null;
    private yellowTutorialGhost: Node | null = null;
    private yellowTutorialHandHome: Vec3 | null = null;
    private yellowTutorialMaterials: Material[] = [];
    private readonly yellowTutorialMotion = { t: 0 };

    // Game timer state
    private gameTimeElapsed = 0;
    private readonly gameTimeDuration = 35; // seconds
    private gameTimeActive = false;
    private gameTimeStarted = false;
    private challengeStarted = false;
    private challengeFailed = false;
    private challengeSolved = false;
    private challengeObstacleCount = 0;
    private challengeObstaclesCleared = 0;
    private challengeProgressStep = 0;
    private audioRoot: Node | null = null;
    private bgmSource: AudioSource | null = null;
    private dragSource: AudioSource | null = null;
    private bgmStarted = false;

    onLoad() {
        // AppLovin loading begins while Cocos initializes the scene components
        // and prepares the playable before input is enabled in start().
        Analytics.trackEvent(analyticsEvents.LOADING);
    }

    start() {
        this.camera = this.camera || find('Main Camera')?.getComponent(Camera) || null;
        this.refreshSceneReferences();
        this.prepareAudio();
        input.on(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.on(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.on(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.on(Input.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
        // Loop a translucent copy of the yellow piece toward its shredder. The
        // authored gameplay block stays fixed and fully interactive underneath.
        if (this.hand) this.startYellowShredderTutorial();
        // Initialize game timer state (timer will start on first player interaction).
        this.gameTimeElapsed = 0;
        this.gameTimeActive = false;
        this.gameTimeStarted = false;
        this.challengeStarted = false;
        this.challengeFailed = false;
        this.challengeSolved = false;
        this.challengeObstacleCount = this.elements.reduce((total, element) => {
            if (this.isChallengeGoalElement(element)) return total;
            return total + element.blockNodes.filter((block) => !!block && block.isValid).length;
        }, 0);
        this.challengeObstaclesCleared = 0;
        this.challengeProgressStep = 0;
        // Ensure CTA is inactive at start.
        if (this.cta && this.cta.isValid) this.cta.active = false;
        // LOADED is required whenever LOADING is emitted. DISPLAYED follows
        // only after the complete scene is ready for player interaction.
        Analytics.trackEvent(analyticsEvents.LOADED);
        Analytics.trackEvent(analyticsEvents.DISPLAYED);
    }

    update(deltaTime: number) {
        if (!this.gameTimeActive) return;
        this.gameTimeElapsed += deltaTime;
        if (this.gameTimeElapsed >= this.gameTimeDuration) {
            this.gameTimeActive = false;
            // This is an ad-duration endcard, not a gameplay failure. Do not
            // emit CHALLENGE_FAILED for a player who simply reached ad time.
            this.showCTA();
        }
    }

    onDestroy() {
        input.off(Input.EventType.TOUCH_START, this.onTouchStart, this);
        input.off(Input.EventType.TOUCH_MOVE, this.onTouchMove, this);
        input.off(Input.EventType.TOUCH_END, this.onTouchEnd, this);
        input.off(Input.EventType.TOUCH_CANCEL, this.onTouchCancel, this);
        this.finishYellowShredderTutorial(false);
        this.stopTutorialHand();
        this.gameTimeActive = false;
        this.bgmSource?.stop();
        this.dragSource?.stop();
        this.bgmStarted = false;
    }

    /** Creates dedicated sources without requiring scene AudioSource setup. */
    private prepareAudio() {
        if (this.audioRoot || (!this.bgmClip && !this.dragClip)) return;

        this.audioRoot = new Node('GameAudio');
        this.node.addChild(this.audioRoot);

        if (this.bgmClip) {
            const bgmNode = new Node('BGM');
            this.audioRoot.addChild(bgmNode);
            this.bgmSource = bgmNode.addComponent(AudioSource);
            this.bgmSource.clip = this.bgmClip;
            this.bgmSource.loop = true;
            this.bgmSource.volume = Math.max(0, Math.min(1, this.bgmVolume));
        }

        if (this.dragClip) {
            const dragNode = new Node('DragSFX');
            this.audioRoot.addChild(dragNode);
            this.dragSource = dragNode.addComponent(AudioSource);
            this.dragSource.volume = Math.max(0, Math.min(1, this.dragVolume));
        }
    }

    /** Must be called synchronously from input so mobile browser autoplay policies are satisfied. */
    private startBgmFromInteraction() {
        if (this.bgmStarted || !this.bgmSource || !this.bgmClip) return;
        this.bgmStarted = true;
        this.bgmSource.play();
    }

    private startTutorialHand() {
        if (!this.hand) return;
        this.tutorialHandActive = true;
        this.showHandIdle();
        // Pulse function: show click briefly, then return to idle.
        this.tutorialHandPulseFn = () => {
            if (!this.tutorialHandActive) return;
            // Idle -> Click
            this.showHandClick();

            // Simulate a short press then a drag motion, then return to idle.
            const dragOutDuration = 0.28;
            const dragBackDuration = 0.28;
            const totalDrag = dragOutDuration + dragBackDuration;

            // Choose a small local offset to read as a drag gesture. Adjust as needed.
            const home = this.hand.position.clone();
            const dragOffset = new Vec3(0, -0.3, -0.3);

            // Start drag tween: out then back.
            Tween.stopAllByTarget(this.hand);
            tween(this.hand)
                .to(dragOutDuration, { position: home.clone().add(dragOffset) }, { easing: 'sineOut' })
                .to(dragBackDuration, { position: home }, { easing: 'sineIn' })
                .start();

            // After the drag completes, go to idle.
            this.scheduleOnce(() => {
                if (!this.tutorialHandActive) return;
                this.showHandIdle();
            }, totalDrag);
        };

        // Run immediately and then repeat every 1.6s.
        this.tutorialHandPulseFn();
        this.schedule(this.tutorialHandPulseFn, 1.6);
    }

    /** Loops a translucent visual copy from the Yellow block to its authored shredder. */
    private startYellowShredderTutorial() {
        if (!this.hand || !this.hand.isValid) return;
        const yellow = this.elements.find((element) => element.elementId.trim().toLowerCase() === 'yellow');
        const block = yellow?.blockNodes.find((entry) => entry?.isValid) || null;
        const shredder = yellow?.targetShredders.find((entry) => entry?.isValid) || null;
        if (!block || !shredder) {
            this.startTutorialHand();
            return;
        }

        this.yellowTutorialActive = true;
        this.yellowTutorialBlock = block;
        this.yellowTutorialShredder = shredder;
        this.yellowTutorialHandHome = this.hand.worldPosition.clone();

        const ghost = instantiate(block);
        ghost.name = 'YellowTutorialGhost';
        const ghostBehaviour = ghost.getComponent(Block);
        if (ghostBehaviour) ghostBehaviour.enabled = false;
        for (const collider of ghost.getComponentsInChildren(BoxCollider)) collider.enabled = false;
        for (const body of ghost.getComponentsInChildren(RigidBody)) body.enabled = false;
        (block.parent || this.node).addChild(ghost);
        ghost.setWorldPosition(block.worldPosition);
        this.yellowTutorialGhost = ghost;
        this.makeYellowTutorialGhostTranslucent(
            ghost,
            this.blockMainColour(block) || new Color(255, 216, 12, 255),
        );

        const blockStart = block.worldPosition.clone();
        const blockEnd = this.yellowTutorialDropPoint(block, shredder);
        const handYOffset = this.yellowTutorialHandHome.y - blockStart.y;
        const handStart = new Vec3(blockStart.x, blockStart.y + handYOffset, blockStart.z);
        const handEnd = new Vec3(blockEnd.x, blockEnd.y + handYOffset, blockEnd.z);
        this.hand.setWorldPosition(handStart);
        this.showHandIdle();

        const applyMotion = (fromBlock: Readonly<Vec3>, toBlock: Readonly<Vec3>,
            fromHand: Readonly<Vec3>, toHand: Readonly<Vec3>) => {
            if (!this.yellowTutorialActive || !ghost.isValid || !this.hand?.isValid) return;
            const t = this.yellowTutorialMotion.t;
            ghost.setWorldPosition(new Vec3(
                fromBlock.x + (toBlock.x - fromBlock.x) * t,
                fromBlock.y + (toBlock.y - fromBlock.y) * t,
                fromBlock.z + (toBlock.z - fromBlock.z) * t,
            ));
            this.hand.setWorldPosition(new Vec3(
                fromHand.x + (toHand.x - fromHand.x) * t,
                fromHand.y + (toHand.y - fromHand.y) * t,
                fromHand.z + (toHand.z - fromHand.z) * t,
            ));
        };

        Tween.stopAllByTarget(this.yellowTutorialMotion);
        this.yellowTutorialMotion.t = 0;
        tween(this.yellowTutorialMotion)
            .delay(0.35)
            .call(() => this.showHandClick())
            .to(1.25, { t: 1 }, {
                easing: 'sineInOut',
                onUpdate: () => applyMotion(blockStart, blockEnd, handStart, handEnd),
            })
            .call(() => shredder.getComponent(Shredder)?.setAnticipation(true, this.blockMainColour(block)))
            .delay(0.42)
            .call(() => {
                shredder.getComponent(Shredder)?.setAnticipation(false, null);
                this.yellowTutorialMotion.t = 0;
            })
            .to(0.48, { t: 1 }, {
                easing: 'sineInOut',
                onUpdate: () => applyMotion(blockEnd, blockStart, handEnd, handStart),
            })
            .call(() => {
                this.yellowTutorialMotion.t = 0;
                if (ghost.isValid) ghost.setWorldPosition(blockStart);
                if (this.hand?.isValid) {
                    this.hand.setWorldPosition(handStart);
                    this.showHandIdle();
                }
            })
            .union()
            .repeatForever()
            .start();
    }

    /** Gives the moving tutorial copy its own transparent materials. */
    private makeYellowTutorialGhostTranslucent(ghost: Node, sourceColour: Color) {
        this.yellowTutorialMaterials = [];
        for (const renderer of ghost.getComponentsInChildren(MeshRenderer)) {
            for (let index = 0; index < renderer.sharedMaterials.length; index++) {
                const material = new Material();
                material.initialize({ effectName: 'builtin-standard', technique: 1 });
                material.setProperty('mainColor', new Color(sourceColour.r, sourceColour.g, sourceColour.b, 92));
                material.setProperty('roughness', 0.7);
                material.setProperty('metallic', 0.35);
                material.setProperty('specularIntensity', 0.45);
                renderer.setMaterial(material, index);
                this.yellowTutorialMaterials.push(material);
            }
        }
    }

    /** Uses the centre of the shredder's authored drop trigger as the tutorial destination. */
    private yellowTutorialDropPoint(block: Node, shredder: Node) {
        const collider = shredder.getComponent(Shredder)?.dropColliders()[0] || null;
        if (!collider) return new Vec3(shredder.worldPosition.x, block.worldPosition.y, shredder.worldPosition.z);
        const bounds = this.worldBounds(collider);
        return new Vec3(
            (bounds.minX + bounds.maxX) * 0.5,
            block.worldPosition.y,
            (bounds.minZ + bounds.maxZ) * 0.5,
        );
    }

    /** Removes the yellow route and optionally resumes the authored hand tutorial. */
    private finishYellowShredderTutorial(startNormalTutorial: boolean) {
        if (!this.yellowTutorialActive) return;
        this.yellowTutorialActive = false;
        Tween.stopAllByTarget(this.yellowTutorialMotion);
        this.yellowTutorialShredder?.getComponent(Shredder)?.setAnticipation(false, null);
        if (this.yellowTutorialGhost?.isValid) this.yellowTutorialGhost.destroy();
        for (const material of this.yellowTutorialMaterials) material.destroy();
        if (this.hand?.isValid && this.yellowTutorialHandHome) {
            this.hand.setWorldPosition(this.yellowTutorialHandHome);
        }
        this.yellowTutorialBlock = null;
        this.yellowTutorialShredder = null;
        this.yellowTutorialGhost = null;
        this.yellowTutorialHandHome = null;
        this.yellowTutorialMaterials = [];
        this.yellowTutorialMotion.t = 0;
        if (startNormalTutorial) this.startTutorialHand();
        else this.hideHand();
    }

    private stopTutorialHand() {
        this.tutorialHandActive = false;
        if (this.tutorialHandPulseFn) {
            try { this.unschedule(this.tutorialHandPulseFn); } catch (_) { /* ignore */ }
            this.tutorialHandPulseFn = null;
        }
        // Stop any running hand tweens and hide.
        try { Tween.stopAllByTarget(this.hand); } catch (_) { /* ignore */ }
        this.hideHand();
    }

    /** Rebuilds runtime state exclusively from the Elements inspector arrays. */
    refreshSceneReferences() {
        // Search from the actual scene root. This keeps the BoardPhysical
        // collider lookup valid even when GameManager is nested differently in
        // another level scene.
        let sceneRoot: Node = this.node;
        while (sceneRoot.parent) sceneRoot = sceneRoot.parent;
        this.boardPhysical = this.findDescendant(sceneRoot, 'BoardPhysical');
        this.boardShape = null;
        this.blocks = [];
        for (const element of this.elements) {
            for (const block of element.blockNodes) {
                if (block && block.isValid && this.blocks.indexOf(block) === -1) this.blocks.push(block);
            }
        }
        for (const block of this.blocks) {
            const body = block.getComponent(RigidBody);
            if (body) {
                body.useGravity = false;
                body.enabled = false;
            }
        }
        // Cache the authored board outline before creating its logical cells.
        // readBoardShape() uses the initial block rows to calibrate the H-shaped
        // neck, so it must run while every piece is still in its scene position.
        this.boardShape = this.readBoardShape();
        this.rebuildBoardGrid();
    }

    /**
     * Block follows are smoothed in Block.update(), after touch input has been
     * processed. Clamp the final world position too: this closes the one-frame
     * escape that can happen on a very fast drag. The authored BoardPhysical
     * wall colliders remain the only boundary data used here.
     */
    lateUpdate() {
        if (!this.grabbed || this.isCrushing) return;
        const constrained = this.grabbed.worldPosition.clone();
        this.keepInsideBoardColliders(this.grabbed, constrained);
        if (!this.canPlaceWithoutOverlap(this.grabbed, constrained) && this.lastLegalDragPosition) {
            constrained.set(
                this.lastLegalDragPosition.x,
                this.lastLegalDragPosition.y,
                this.lastLegalDragPosition.z,
            );
        } else {
            this.lastLegalDragPosition = constrained.clone();
        }
        if (constrained.x !== this.grabbed.worldPosition.x || constrained.z !== this.grabbed.worldPosition.z) {
            this.grabbed.setWorldPosition(constrained);
        }
    }

    private onTouchStart(event: EventTouch) {
        this.startBgmFromInteraction();
        // The first real touch removes the yellow route, restores the hand to
        // its authored scene position, and starts the original repeating cue.
        const keepTutorialHand = this.yellowTutorialActive;
        if (this.yellowTutorialActive) this.finishYellowShredderTutorial(true);
        if (this.challengeSolved || this.challengeFailed || this.isCrushing || this.grabbed) return;
        const block = this.pickBlock(event);
        const behaviour = block?.getComponent(Block) || null;
        if (!block || !behaviour || !behaviour.beginDrag()) return;
        if (!this.challengeStarted) {
            this.challengeStarted = true;
            Analytics.trackEvent(analyticsEvents.CHALLENGE_STARTED);
        }
        if (!this.gameTimeStarted) {
            this.gameTimeStarted = true;
            this.gameTimeActive = true;
            this.gameTimeElapsed = 0;
        }
        if (this.dragSource && this.dragClip) this.dragSource.playOneShot(this.dragClip);
        this.grabbed = block;
        // Preserve the hand on the tap that dismisses the looping guide.
        if (!keepTutorialHand) this.stopTutorialHand();
        this.lastLegalDragPosition = block.worldPosition.clone();
        this.dragStartGridPosition = block.worldPosition.clone();
        this.dragGridOffset.set(this.gridOffsetForBlock(block));
        this.dragHeight = block.worldPosition.y;
        const touchPoint = this.pointOnDragPlane(event);
        Vec3.subtract(this.dragOffset, block.worldPosition, touchPoint);
        this.dragOffset.y = 0;
    }

    private onTouchMove(event: EventTouch) {
        const block = this.grabbed;
        if (!block) return;
        const target = this.pointOnDragPlane(event);
        target.x += this.dragOffset.x;
        target.z += this.dragOffset.z;
        this.keepInsideBoardColliders(block, target);
        const resolved = this.resolveDragTarget(block, target);
        const behaviour = block.getComponent(Block);
        behaviour?.moveTo(resolved);
        // The block follows the finger freely, while its glow shows the exact
        // nearby cell that will receive it on release. Never preview a distant
        // empty cell when the current position is rejected by a wall collider.
        behaviour?.previewPlacementAt(this.nearestGridPlacement(
            block,
            resolved,
            true,
            this.localGridSnapRadius(),
        ));
        this.updateGateAnticipation(block);
    }

    private onTouchEnd() {
        const block = this.grabbed;
        if (!block) return;
        this.grabbed = null;
        // Complete the short follow smoothing before evaluating the drop.
        // This keeps a quick release over a gate from feeling unresponsive.
        block.getComponent(Block)?.settleDrag();
        const released = block.worldPosition.clone();
        this.keepInsideBoardColliders(block, released);
        if (!this.canPlaceWithoutOverlap(block, released) && this.lastLegalDragPosition) {
            released.set(
                this.lastLegalDragPosition.x,
                this.lastLegalDragPosition.y,
                this.lastLegalDragPosition.z,
            );
        }
        block.setWorldPosition(released);
        this.lastLegalDragPosition = null;
        const shredder = this.matchingShredderDrop(block);
        if (shredder) {
            this.dragStartGridPosition = null;
            this.dragGridOffset.set(Vec3.ZERO);
            this.crush(block, shredder);
        }
        else {
            // Place only on a legal, unoccupied cell. When every nearby cell is
            // occupied, the original cell remains a guaranteed, predictable
            // fallback instead of leaving the block between rows or columns.
            const placement = this.nearestGridPlacement(
                block,
                released,
                true,
                this.localGridSnapRadius(),
            )
                || this.dragStartGridPosition
                || released;
            this.dragStartGridPosition = null;
            this.dragGridOffset.set(Vec3.ZERO);
            this.clearGateAnticipation();
            block.getComponent(Block)?.endDragAt(placement);
        }
    }

    private onTouchCancel() { this.onTouchEnd(); }

    private crush(block: Node, shredderNode: Node) {
        if (this.isCrushing || !block.isValid) return;
        const blockBehaviour = block.getComponent(Block);
        const shredder = shredderNode.getComponent(Shredder);
        if (!blockBehaviour || !shredder) return;

        this.isCrushing = true;
        if (this.anticipated === shredder) {
            // Keep the matching gate energized throughout the intake. The
            // crush feedback turns it off exactly when the block reaches the rim.
            this.anticipated = null;
        } else {
            this.clearGateAnticipation();
            shredder.setAnticipation(true, this.blockMainColour(block));
        }
        const direction = this.shredderExitNormal(block, shredderNode);
        const entry = this.shredderEntryWorld(block, shredderNode, direction);
        const exit = this.shredderExitWorld(block, shredderNode, direction);
        // Intake follows the aligned mouth coordinate instead of retaining an
        // offset release coordinate that can make a block appear to jump.
        if (Math.abs(direction.z) > 0) exit.x = entry.x;
        else exit.z = entry.z;
        const isChallengeGoal = this.isChallengeGoalBlock(block);

        // The block stays intact while it aligns and travels outward; crush
        // feedback begins only after it has visibly entered the mouth.
        blockBehaviour.consumeThrough(exit, 0.50, () => {
            // Begin the authored crush feedback after 20% of the block has
            // entered the shredder, while the remaining intake continues.
            shredder.playCrushFeedback(blockBehaviour);
            this.playCameraImpact(direction);
        }, () => {
            // The child particle system is inactive before the crush, so its first
            // visible chips arrive on the following render frame. The block is
            // removed only after it completes the remaining 80% of its intake.
            this.scheduleOnce(() => {
                if (block.isValid) {
                    this.blocks = this.blocks.filter((entry) => entry !== block);
                    this.recordGameplayProgress(isChallengeGoal);
                    block.destroy();
                }
                this.isCrushing = false;
            }, 0.04);
        }, entry);
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

    private setHandChildState(childName: string, active: boolean) {
        if (!this.hand || !this.hand.isValid) return;
        let child = this.hand.getChildByName(childName);
        if (!child) {
            const lname = childName.toLowerCase();
            const findDesc = (node: Node): Node | null => {
                for (const c of node.children) {
                    if (c.name.toLowerCase().includes(lname)) return c;
                    const r = findDesc(c);
                    if (r) return r;
                }
                return null;
            };
            child = findDesc(this.hand);
        }
        if (!child) {
            // If children are named arbitrarily (e.g. "Quad", "Quad-001"),
            // map 'Idle' -> first child and 'Click' -> second child as a sensible default.
            const lname = childName.toLowerCase();
            const children = this.hand.children;
            if (children.length > 0) {
                if (lname.includes('idle')) child = children[0];
                else if (lname.includes('click')) child = children[1] || children[0];
                else child = children[0];
            }

            // Still not found? fallback to first descendant with an Animation.
            if (!child) {
                let foundAnimNode: Node | null = null;
                const findAnim = (node: Node) => {
                    for (const c of node.children) {
                        if (c.getComponent(Animation)) { foundAnimNode = c; return; }
                        findAnim(c);
                        if (foundAnimNode) return;
                    }
                };
                findAnim(this.hand);
                if (foundAnimNode) child = foundAnimNode;
            }

            if (!child) {
                return;
            }
        }
        // Ensure parent is active when showing a child so visuals are visible.
        if (active && (!this.hand.isValid || !this.hand.active)) this.hand.active = true;
        child.active = active;
        const anim = child.getComponent(Animation);
        if (anim) {
            if (active) anim.play();
            else anim.stop();
        } else {
            const parentAnim = this.hand.getComponent(Animation);
            if (parentAnim) {
                try {
                    if (active) {
                        try {
                            parentAnim.play(childName);
                        } catch (_) {
                            parentAnim.play();
                        }
                    } else {
                        parentAnim.stop();
                    }
                } catch (_) { /* ignore */ }
            }
        }
    }

    public showHandIdle() {
        if (!this.hand || !this.hand.isValid) return;
        this.hand.active = true;
        this.setHandChildState('Idle', true);
        this.setHandChildState('Click', false);
    }

    public showHandClick() {
        if (!this.hand || !this.hand.isValid) return;
        this.hand.active = true;
        this.setHandChildState('Idle', false);
        this.setHandChildState('Click', true);
    }

    public hideHand() {
        if (!this.hand || !this.hand.isValid) return;
        this.hand.active = false;
    }

    private showCTA() {
        if (!this.cta || !this.cta.isValid) return;
        this.cta.active = true;
        Analytics.trackEvent(analyticsEvents.ENDCARD_SHOWN);
        // Stop player input when CTA is shown.
        this.gameTimeActive = false;
    }

    /** Yellow entering its shredder completes the challenge; other successful
     * shreds advance progress according to the visible board pieces cleared. */
    private recordGameplayProgress(isChallengeGoal: boolean) {
        if (!this.challengeStarted || this.challengeFailed || this.challengeSolved) return;
        if (isChallengeGoal) {
            this.challengeSolved = true;
            this.gameTimeActive = false;
            Analytics.trackEvent(analyticsEvents.CHALLENGE_SOLVED);
            this.showCTA();
            return;
        }

        this.challengeObstaclesCleared++;
        if (this.challengeObstacleCount <= 0) return;
        const progress = this.challengeObstaclesCleared / this.challengeObstacleCount;
        const events = [
            analyticsEvents.CHALLENGE_PASS_25,
            analyticsEvents.CHALLENGE_PASS_50,
            analyticsEvents.CHALLENGE_PASS_75,
        ];
        const thresholds = [0.25, 0.50, 0.75];
        while (this.challengeProgressStep < thresholds.length
            && progress >= thresholds[this.challengeProgressStep]) {
            Analytics.trackEvent(events[this.challengeProgressStep]);
            this.challengeProgressStep++;
        }
    }

    /** Call only when gameplay enters a real authored failure state. */
    public failChallenge() {
        if (!this.challengeStarted || this.challengeFailed || this.challengeSolved) return;
        this.challengeFailed = true;
        this.gameTimeActive = false;
        Analytics.trackEvent(analyticsEvents.CHALLENGE_FAILED);
    }

    /** Call from the player's retry action after a real challenge failure. */
    public retryChallenge() {
        if (!this.challengeStarted || !this.challengeFailed || this.challengeSolved) return;
        this.challengeFailed = false;
        this.gameTimeElapsed = 0;
        this.gameTimeActive = true;
        if (this.cta?.isValid) this.cta.active = false;
        Analytics.trackEvent(analyticsEvents.CHALLENGE_RETRY);
    }

    private isChallengeGoalElement(element: GameElement) {
        return element.elementId.trim().toLowerCase() === 'yellow';
    }

    private isChallengeGoalBlock(block: Node) {
        return this.elements.some((element) =>
            this.isChallengeGoalElement(element) && element.blockNodes.indexOf(block) !== -1,
        );
    }

    public getRemainingGameTime(): number {
        return Math.max(0, this.gameTimeDuration - this.gameTimeElapsed);
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
            // The Elements inspector explicitly assigns every block colour to
            // its legal shredder. Do not make that authored link depend on a
            // second material comparison: prefab material overrides can make
            // two visibly identical Pink materials appear as different runtime
            // objects and incorrectly reject an otherwise valid drop.
            if (shredder && this.overlapsShredderTrigger(block, target)) return target;
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
        const blockRects = this.colliderRects(block, block.worldPosition);
        const blockBounds = {
            minX: Math.min(...blockRects.map((rect) => rect.minX)),
            maxX: Math.max(...blockRects.map((rect) => rect.maxX)),
            minZ: Math.min(...blockRects.map((rect) => rect.minZ)),
            maxZ: Math.max(...blockRects.map((rect) => rect.maxZ)),
        };
        const blockCenterX = (blockBounds.minX + blockBounds.maxX) * 0.5;
        const blockCenterZ = (blockBounds.minZ + blockBounds.maxZ) * 0.5;
        const normal = this.shredderExitNormal(block, shredder);

        for (const targetCollider of targets) {
            const trigger = this.worldBounds(targetCollider);
            const intakeMargin = 0.15;
            if (Math.abs(normal.z) > 0) {
                // For a top/bottom gate, X is the mouth's lateral axis. The
                // block centre must reach the slit; a touching corner is not a
                // valid drop. Z keeps a small wall/collider tolerance.
                const aligned = blockCenterX >= trigger.minX - intakeMargin
                    && blockCenterX <= trigger.maxX + intakeMargin;
                const reachesMouth = blockBounds.minZ <= trigger.maxZ + intakeMargin
                    && blockBounds.maxZ >= trigger.minZ - intakeMargin;
                if (aligned && reachesMouth) return true;
            } else {
                const aligned = blockCenterZ >= trigger.minZ - intakeMargin
                    && blockCenterZ <= trigger.maxZ + intakeMargin;
                const reachesMouth = blockBounds.minX <= trigger.maxX + intakeMargin
                    && blockBounds.maxX >= trigger.minX - intakeMargin;
                if (aligned && reachesMouth) return true;
            }
        }
        return false;
    }

    /**
     * Keeps the complete block footprint inside the board silhouette. Physics
     * cannot do this by itself because dragging writes world transforms
     * directly. The outer limits and the narrow middle section are derived
     * from the authored wall colliders, so the H-board dimensions are not
     * duplicated in code.
     */
    private keepInsideBoardColliders(block: Node, target: Vec3) {
        const board = this.boardShape || (this.boardShape = this.readBoardShape());
        if (!board) return;
        const rects = this.colliderRects(block, target);
        const minOffsetX = Math.min(...rects.map((rect) => rect.minX)) - target.x;
        const maxOffsetX = Math.max(...rects.map((rect) => rect.maxX)) - target.x;
        const minOffsetZ = Math.min(...rects.map((rect) => rect.minZ)) - target.z;
        const maxOffsetZ = Math.max(...rects.map((rect) => rect.maxZ)) - target.z;

        const outerMinX = board.outer.minX - minOffsetX;
        const outerMaxX = board.outer.maxX - maxOffsetX;
        const outerMinZ = board.outer.minZ - minOffsetZ;
        const outerMaxZ = board.outer.maxZ - maxOffsetZ;
        target.x = this.clamp(target.x, outerMinX, outerMaxX);
        target.z = this.clamp(target.z, outerMinZ, outerMaxZ);

        const neck = board.neck;
        if (!neck) return;
        const footprintMinX = target.x + minOffsetX;
        const footprintMaxX = target.x + maxOffsetX;
        // Select the H-board section from the block centre. Using footprint
        // overlap here made an adjacent tray row count as part of the neck,
        // while the first real neck row could count as part of the wide tray.
        const insideNeckBand = target.z >= neck.minZ && target.z <= neck.maxZ;
        const fitsNeckWidth = footprintMinX >= neck.minX && footprintMaxX <= neck.maxX;
        if (!insideNeckBand || fitsNeckWidth) return;

        // At a shoulder, choose the smallest legal correction. A piece moving
        // straight into the wall stays on that side; moving towards the centre
        // lets it slide naturally into the neck.
        const desiredX = target.x;
        const desiredZ = target.z;
        const desired = new Vec3(desiredX, target.y, desiredZ);
        const candidates: Vec3[] = [];
        const neckMinX = neck.minX - minOffsetX;
        const neckMaxX = neck.maxX - maxOffsetX;
        if (neckMinX <= neckMaxX) {
            candidates.push(new Vec3(this.clamp(target.x, neckMinX, neckMaxX), target.y, target.z));
        }
        // Crossing a shoulder is legal only when the *whole collider* has
        // cleared it. Clamping the block centre to the transition still left
        // half of the piece hanging in the side pocket/over the purple rim.
        const belowNeck = neck.minZ - maxOffsetZ - 0.001;
        if (belowNeck >= outerMinZ) candidates.push(new Vec3(target.x, target.y, Math.min(target.z, belowNeck)));
        const aboveNeck = neck.maxZ - minOffsetZ + 0.001;
        if (aboveNeck <= outerMaxZ) candidates.push(new Vec3(target.x, target.y, Math.max(target.z, aboveNeck)));
        if (candidates.length === 0) return;

        let best = candidates[0];
        let bestDistance = this.planarDistanceSquared(best, desired);
        for (let index = 1; index < candidates.length; index++) {
            const distance = this.planarDistanceSquared(candidates[index], desired);
            if (distance < bestDistance) {
                best = candidates[index];
                bestDistance = distance;
            }
        }
        target.x = best.x;
        target.z = best.z;
    }

    private canPlaceWithoutOverlap(dragged: Node, target: Readonly<Vec3>) {
        const draggingRects = this.colliderRects(dragged, target, this.dragCollisionInset);
        for (const other of this.blocks) {
            if (other === dragged || !other.isValid) continue;
            for (const current of draggingRects) {
                for (const occupied of this.colliderRects(other, other.worldPosition, this.dragCollisionInset)) {
                    if (this.rectanglesOverlap(current, occupied)) return false;
                }
            }
        }
        return true;
    }

    /**
     * Sweeps toward the finger in small increments. Fast input therefore
     * cannot tunnel through another piece, while testing each axis separately
     * at every increment lets the held block slide through a real corridor
     * instead of freezing because only the final finger point is occupied.
     */
    private resolveDragTarget(dragged: Node, desired: Readonly<Vec3>) {
        const destination = new Vec3(desired.x, desired.y, desired.z);
        const start = dragged.worldPosition.clone();
        const deltaX = destination.x - start.x;
        const deltaZ = destination.z - start.z;
        // A quarter-cell sweep remains stable even when a browser coalesces
        // several pointer events during a forceful drag.
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaZ)) / 0.25));
        const stepX = deltaX / steps;
        const stepZ = deltaZ / steps;
        let position = start;

        for (let step = 0; step < steps; step++) {
            const direct = new Vec3(position.x + stepX, destination.y, position.z + stepZ);
            this.keepInsideBoardColliders(dragged, direct);
            if (this.canPlaceWithoutOverlap(dragged, direct)) {
                position = direct;
                continue;
            }

            const sliding: Vec3[] = [];
            if (Math.abs(stepX) > 0.0001) {
                const xOnly = new Vec3(position.x + stepX, destination.y, position.z);
                this.keepInsideBoardColliders(dragged, xOnly);
                if (this.canPlaceWithoutOverlap(dragged, xOnly)) sliding.push(xOnly);
            }
            if (Math.abs(stepZ) > 0.0001) {
                const zOnly = new Vec3(position.x, destination.y, position.z + stepZ);
                this.keepInsideBoardColliders(dragged, zOnly);
                if (this.canPlaceWithoutOverlap(dragged, zOnly)) sliding.push(zOnly);
            }
            if (sliding.length === 0) break;

            position = sliding.reduce((best, candidate) =>
                this.planarDistanceSquared(candidate, destination) < this.planarDistanceSquared(best, destination)
                    ? candidate
                    : best,
            );
        }
        return position;
    }

    private planarDistanceSquared(a: Readonly<Vec3>, b: Readonly<Vec3>) {
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        return dx * dx + dz * dz;
    }

    /**
     * Creates the logical board from the small authored blocks. This preserves
     * hand-tuned row spacing in the H-shaped playable while the inspector
     * column/row settings remain a fallback for an empty level.
     */
    private rebuildBoardGrid() {
        this.gridCells = [];
        if (!this.boardPhysical) return;

        const measured = this.blocks.map((block) => {
            const rects = this.colliderRects(block, block.worldPosition);
            const minX = Math.min(...rects.map((rect) => rect.minX));
            const maxX = Math.max(...rects.map((rect) => rect.maxX));
            const minZ = Math.min(...rects.map((rect) => rect.minZ));
            const maxZ = Math.max(...rects.map((rect) => rect.maxZ));
            return { block, width: maxX - minX, depth: maxZ - minZ };
        });
        this.gridUnitWidth = measured.length > 0 ? Math.min(...measured.map((entry) => entry.width)) : 0;
        this.gridUnitDepth = measured.length > 0 ? Math.min(...measured.map((entry) => entry.depth)) : 0;
        const unitBlocks = measured.filter((entry) =>
            entry.width <= this.gridUnitWidth * 1.25
            && entry.depth <= this.gridUnitDepth * 1.25);
        const authoredColumns = this.clusterGridCoordinates(unitBlocks.map((entry) => entry.block.worldPosition.x));
        const authoredRows = this.clusterGridCoordinates(unitBlocks.map((entry) => entry.block.worldPosition.z));
        if (authoredColumns.length >= 2 && authoredRows.length >= 2) {
            for (let row = 0; row < authoredRows.length; row++) {
                for (let column = 0; column < authoredColumns.length; column++) {
                    this.gridCells.push({
                        column,
                        row,
                        x: authoredColumns[column],
                        z: authoredRows[row],
                    });
                }
            }
            return;
        }

        const columns = Math.max(1, Math.round(this.boardColumns));
        const rows = Math.max(1, Math.round(this.boardRows));
        const cellSize = Math.max(0.01, this.gridCellSize);
        const origin = this.boardPhysical.worldPosition;
        const columnOffset = (columns - 1) * 0.5;
        const rowOffset = (rows - 1) * 0.5;
        for (let row = 0; row < rows; row++) {
            for (let column = 0; column < columns; column++) {
                this.gridCells.push({
                    column,
                    row,
                    x: origin.x + (column - columnOffset) * cellSize,
                    z: origin.z + (row - rowOffset) * cellSize,
                });
            }
        }
    }

    /** Merges scene coordinates that differ only by minor authoring noise. */
    private clusterGridCoordinates(values: number[]) {
        const clusters: number[][] = [];
        for (const value of values.slice().sort((a, b) => a - b)) {
            const cluster = clusters.find((entry) => Math.abs(entry[0] - value) < 0.25);
            if (cluster) cluster.push(value);
            else clusters.push([value]);
        }
        return clusters.map((cluster) => cluster.reduce((sum, value) => sum + value, 0) / cluster.length);
    }

    /** One-cell pieces use cell centres; multi-cell pieces retain their authored phase. */
    private gridOffsetForBlock(block: Node) {
        if (this.gridCells.length === 0) return Vec3.ZERO.clone();
        const rects = this.colliderRects(block, block.worldPosition);
        const width = Math.max(...rects.map((rect) => rect.maxX)) - Math.min(...rects.map((rect) => rect.minX));
        const depth = Math.max(...rects.map((rect) => rect.maxZ)) - Math.min(...rects.map((rect) => rect.minZ));
        if (width <= this.gridUnitWidth * 1.25 && depth <= this.gridUnitDepth * 1.25) return Vec3.ZERO.clone();
        const current = block.worldPosition;
        const nearest = this.gridCells.reduce((best, cell) => {
            const bestDistance = (best.x - current.x) * (best.x - current.x) + (best.z - current.z) * (best.z - current.z);
            const distance = (cell.x - current.x) * (cell.x - current.x) + (cell.z - current.z) * (cell.z - current.z);
            return distance < bestDistance ? cell : best;
        });
        return new Vec3(current.x - nearest.x, 0, current.z - nearest.z);
    }

    /** Returns a legal nearby cell, never an arbitrary empty cell elsewhere on the board. */
    private nearestGridPlacement(
        block: Node,
        desired: Readonly<Vec3>,
        requireUnoccupied: boolean,
        maxDistance = Number.POSITIVE_INFINITY,
    ): Vec3 | null {
        const cells = this.gridCells.slice().sort((a, b) => {
            const ax = a.x + this.dragGridOffset.x;
            const az = a.z + this.dragGridOffset.z;
            const bx = b.x + this.dragGridOffset.x;
            const bz = b.z + this.dragGridOffset.z;
            const distanceA = (ax - desired.x) * (ax - desired.x) + (az - desired.z) * (az - desired.z);
            const distanceB = (bx - desired.x) * (bx - desired.x) + (bz - desired.z) * (bz - desired.z);
            return distanceA - distanceB;
        });
        const maxDistanceSquared = maxDistance * maxDistance;
        for (const cell of cells) {
            const candidate = new Vec3(
                cell.x + this.dragGridOffset.x,
                desired.y,
                cell.z + this.dragGridOffset.z,
            );
            if (this.planarDistanceSquared(candidate, desired) > maxDistanceSquared) break;
            if (!this.isExactBoardPlacement(block, candidate)) continue;
            if (requireUnoccupied && !this.canPlaceWithoutOverlap(block, candidate)) continue;
            return candidate;
        }
        return null;
    }

    /** Covers the farthest point within one grid cell without permitting a board-wide snap. */
    private localGridSnapRadius() {
        const cellSize = Math.max(this.gridCellSize, this.gridUnitWidth, this.gridUnitDepth, 0.5);
        return cellSize * 0.8;
    }

    /** Rejects grid coordinates that the authored H-shaped walls would clamp. */
    private isExactBoardPlacement(block: Node, candidate: Readonly<Vec3>) {
        const constrained = new Vec3(candidate.x, candidate.y, candidate.z);
        this.keepInsideBoardColliders(block, constrained);
        // A small allowance preserves edge rows that were visually authored a
        // few hundredths beyond the older imported wall colliders.
        const tolerance = Math.max(0.01, this.gridCellSize * 0.1);
        return Math.abs(constrained.x - candidate.x) < tolerance
            && Math.abs(constrained.z - candidate.z) < tolerance;
    }

    private readBoardShape(): BoardShape | null {
        if (!this.boardPhysical) return null;
        const origin = this.boardPhysical.worldPosition;
        const verticalWalls: Bounds3D[] = [];
        const horizontalWalls: Bounds3D[] = [];
        for (const collider of this.boardPhysical.getComponents(BoxCollider)) {
            const bounds = this.worldBounds(collider);
            const centerX = (bounds.minX + bounds.maxX) * 0.5;
            const centerZ = (bounds.minZ + bounds.maxZ) * 0.5;
            const halfX = (bounds.maxX - bounds.minX) * 0.5;
            const halfZ = (bounds.maxZ - bounds.minZ) * 0.5;
            if (halfX < halfZ && centerX !== origin.x) verticalWalls.push(bounds);
            else if (halfZ < halfX && centerZ !== origin.z) horizontalWalls.push(bounds);
        }
        const leftWalls = verticalWalls.filter((wall) => (wall.minX + wall.maxX) * 0.5 < origin.x);
        const rightWalls = verticalWalls.filter((wall) => (wall.minX + wall.maxX) * 0.5 > origin.x);
        if (leftWalls.length === 0 || rightWalls.length === 0 || horizontalWalls.length < 2) return null;

        // BoardPhysical may also contain vertical walls inside the H-shaped
        // neck. Only the extreme wall segments define the outer drag bounds;
        // treating every left/right collider as an outside wall makes an inner
        // wall collapse the legal board width and causes sticky drag clamping.
        const wallCenterX = (wall: Bounds3D) => (wall.minX + wall.maxX) * 0.5;
        const farLeftCenter = Math.min(...leftWalls.map(wallCenterX));
        const farRightCenter = Math.max(...rightWalls.map(wallCenterX));
        const outerWallTolerance = 0.25;
        const outerLeftWalls = leftWalls.filter((wall) => Math.abs(wallCenterX(wall) - farLeftCenter) <= outerWallTolerance);
        const outerRightWalls = rightWalls.filter((wall) => Math.abs(wallCenterX(wall) - farRightCenter) <= outerWallTolerance);

        horizontalWalls.sort((a, b) => (a.minZ + a.maxZ) - (b.minZ + b.maxZ));
        const bottomWall = horizontalWalls[0];
        const topWall = horizontalWalls[horizontalWalls.length - 1];
        const outer: Rect = {
            minX: Math.max(...outerLeftWalls.map((wall) => wall.maxX)),
            maxX: Math.min(...outerRightWalls.map((wall) => wall.minX)),
            minZ: bottomWall.maxZ,
            maxZ: topWall.minZ,
        };

        // The remaining horizontal wall segments are the two shoulders of an
        // H-shaped board. Their inward tips define a conservative rectangular
        // neck that no block footprint may cross outside of.
        const shoulders = horizontalWalls.slice(1, -1);
        const shoulderCentersZ = shoulders.map((wall) => (wall.minZ + wall.maxZ) * 0.5);
        const shoulderSplitZ = (Math.min(...shoulderCentersZ) + Math.max(...shoulderCentersZ)) * 0.5;
        const lowerShoulders = shoulders.filter((wall) => (wall.minZ + wall.maxZ) * 0.5 < shoulderSplitZ);
        const upperShoulders = shoulders.filter((wall) => lowerShoulders.indexOf(wall) === -1);
        const leftShoulders = shoulders.filter((wall) => (wall.minX + wall.maxX) * 0.5 < origin.x);
        const rightShoulders = shoulders.filter((wall) => (wall.minX + wall.maxX) * 0.5 > origin.x);
        if (lowerShoulders.length === 0 || upperShoulders.length === 0 || leftShoulders.length === 0 || rightShoulders.length === 0) {
            return { outer, neck: null };
        }
        const neck: Rect = {
            minX: Math.max(...leftShoulders.map((wall) => wall.maxX)),
            maxX: Math.min(...rightShoulders.map((wall) => wall.minX)),
            minZ: Math.max(...lowerShoulders.map((wall) => wall.maxZ)),
            maxZ: Math.min(...upperShoulders.map((wall) => wall.minZ)),
        };
        if (neck.minX >= neck.maxX || neck.minZ >= neck.maxZ) return { outer, neck: null };

        // The imported BoardPhysical shoulders predate this authored layout
        // and are offset along Z. Calibrate only the two neck transitions from
        // the initial rows: neck rows contain multiple blocks whose centres all
        // fit between the shoulder tips; tray rows contain outer columns.
        const rows: Array<{ z: number; xs: number[] }> = [];
        for (const block of this.blocks) {
            if (!block?.isValid) continue;
            const position = block.worldPosition;
            let row = rows.find((candidate) => Math.abs(candidate.z - position.z) < 0.25);
            if (!row) {
                row = { z: position.z, xs: [] };
                rows.push(row);
            }
            row.xs.push(position.x);
        }
        const neckRows = rows.filter((row) => row.xs.length >= 2
            && row.xs.every((x) => x >= neck.minX && x <= neck.maxX));
        if (neckRows.length > 0) {
            const lowestNeckRow = Math.min(...neckRows.map((row) => row.z));
            const highestNeckRow = Math.max(...neckRows.map((row) => row.z));
            const wideRows = rows.filter((row) => row.xs.some((x) => x < neck.minX || x > neck.maxX));
            const rowBelow = wideRows
                .filter((row) => row.z < lowestNeckRow)
                .sort((a, b) => b.z - a.z)[0];
            const rowAbove = wideRows
                .filter((row) => row.z > highestNeckRow)
                .sort((a, b) => a.z - b.z)[0];
            if (rowBelow) neck.minZ = (rowBelow.z + lowestNeckRow) * 0.5;
            if (rowAbove) neck.maxZ = (rowAbove.z + highestNeckRow) * 0.5;
        }
        return { outer, neck };
    }

    private clamp(value: number, min: number, max: number) {
        return Math.max(min, Math.min(max, value));
    }

    private colliderRects(root: Node, rootPosition: Readonly<Vec3>, inset = 0): Rect[] {
        const colliders = root.getComponents(BoxCollider);
        if (colliders.length === 0) return [{ minX: rootPosition.x - 0.9, maxX: rootPosition.x + 0.9, minZ: rootPosition.z - 0.9, maxZ: rootPosition.z + 0.9 }];
        const delta = new Vec3();
        Vec3.subtract(delta, rootPosition, root.worldPosition);
        return colliders.map((collider) => {
            // Rigid-body simulation is disabled for transform-driven pieces.
            // Physics worldBounds may therefore lag one frame behind the node,
            // so build the AABB from the collider's authored box and the live
            // node world matrix instead.
            const center = collider.center;
            const halfX = collider.size.x * 0.5;
            const halfY = collider.size.y * 0.5;
            const halfZ = collider.size.z * 0.5;
            let minX = Number.POSITIVE_INFINITY;
            let maxX = Number.NEGATIVE_INFINITY;
            let minZ = Number.POSITIVE_INFINITY;
            let maxZ = Number.NEGATIVE_INFINITY;
            for (const x of [-halfX, halfX]) {
                for (const y of [-halfY, halfY]) {
                    for (const z of [-halfZ, halfZ]) {
                        const corner = new Vec3(center.x + x, center.y + y, center.z + z);
                        Vec3.transformMat4(corner, corner, collider.node.worldMatrix);
                        minX = Math.min(minX, corner.x);
                        maxX = Math.max(maxX, corner.x);
                        minZ = Math.min(minZ, corner.z);
                        maxZ = Math.max(maxZ, corner.z);
                    }
                }
            }
            return {
                minX: minX + delta.x + inset,
                maxX: maxX + delta.x - inset,
                minZ: minZ + delta.z + inset,
                maxZ: maxZ + delta.z - inset,
            };
        });
    }

    private shredderExitNormal(block: Node, shredder: Node) {
        const center = this.boardPhysical?.worldPosition || Vec3.ZERO;
        const areaCollider = shredder.getComponent(Shredder)?.dropColliders()[0] || null;
        const areaBounds = areaCollider ? this.worldBounds(areaCollider) : null;
        const gateCenterX = areaBounds ? (areaBounds.minX + areaBounds.maxX) * 0.5 : shredder.worldPosition.x;
        const gateCenterZ = areaBounds ? (areaBounds.minZ + areaBounds.maxZ) * 0.5 : shredder.worldPosition.z;
        const dx = gateCenterX - center.x;
        const dz = gateCenterZ - center.z;
        return Math.abs(dx) > Math.abs(dz)
            ? new Vec3(dx >= 0 ? 1 : -1, 0, 0)
            : new Vec3(0, 0, dz >= 0 ? 1 : -1);
    }

    private shredderExitWorld(block: Node, shredder: Node, normal: Readonly<Vec3>) {
        const collider = this.shredderRootCollider(shredder);
        if (!collider) return shredder.worldPosition.clone();
        const bounds = this.worldBounds(collider);
        const exit = block.worldPosition.clone();
        if (Math.abs(normal.z) > 0) exit.z = normal.z > 0 ? bounds.maxZ + this.blockHalfExtent(block, 'z') : bounds.minZ - this.blockHalfExtent(block, 'z');
        else exit.x = normal.x > 0 ? bounds.maxX + this.blockHalfExtent(block, 'x') : bounds.minX - this.blockHalfExtent(block, 'x');
        return exit;
    }

    /** Aligns only across the mouth; the intake axis remains at the released
     * position so the block never teleports forward into the shredder. */
    private shredderEntryWorld(block: Node, shredder: Node, normal: Readonly<Vec3>) {
        const areaCollider = shredder.getComponent(Shredder)?.dropColliders()[0] || null;
        const entry = block.worldPosition.clone();
        if (!areaCollider) return entry;
        const bounds = this.worldBounds(areaCollider);
        if (Math.abs(normal.z) > 0) entry.x = (bounds.minX + bounds.maxX) * 0.5;
        else entry.z = (bounds.minZ + bounds.maxZ) * 0.5;
        return entry;
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
        const world = collider.worldBounds;
        const center = world.center;
        const half = world.halfExtents;
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
        // Imported/model-mounted helper nodes commonly receive a -001 suffix.
        if (root.name === name || root.name.startsWith(`${name}-`)) return root;
        for (const child of root.children) {
            const match = this.findDescendant(child, name);
            if (match) return match;
        }
        return null;
    }
}
