// FILE: /assets/Scripts/TutorialController.ts (Corrected and Safer)

import { _decorator, Component, Node, tween, v3, Vec3, Tween, SpriteFrame, Sprite, UITransform } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('TutorialController')
export class TutorialController extends Component {
    @property({ type: Node, tooltip: "The hand sprite node that will be animated." })
    public handNode: Node | null = null;

    @property({ type: SpriteFrame, tooltip: "The sprite for the idle/pointing hand." })
    public idleHandSprite: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: "The sprite for the hand when it is 'clicked down'." })
    public clickHandSprite: SpriteFrame | null = null;

    private handTween: Tween<Node> | null = null;

    public playTutorial(startNode: Node, endNode: Node): void {
        if (!this.handNode || !this.idleHandSprite || !this.clickHandSprite) return;
        
        // --- ADDED SAFETY CHECK ---
        // Ensure nodes are valid when starting the tutorial
        if (!startNode || !endNode || !startNode.isValid || !endNode.isValid) return;

        this.handNode.active = true;
        this.runAnimationLoop(startNode, endNode);
    }

    public stopTutorial(): void {
        if (this.handTween) {
            this.handTween.stop();
            this.handTween = null;
        }
        if (this.handNode) {
            this.handNode.active = false;
        }
    }

    private runAnimationLoop(startNode: Node, endNode: Node): void {
        const handSprite = this.handNode?.getComponent(Sprite);
        if (!handSprite) return;

        // --- THE MOST IMPORTANT FIX IS HERE ---
        // Before starting a new loop, check if the target nodes were destroyed.
        if (!startNode.isValid || !endNode.isValid) {
            this.stopTutorial();
            return; // Exit gracefully
        }
        
        const startPosition = this.getUIPosition(startNode);
        const endPosition = this.getUIPosition(endNode);

        // If a node was destroyed while getting position, it will return null
        if (!startPosition || !endPosition) {
            this.stopTutorial();
            return;
        }

        handSprite.spriteFrame = this.idleHandSprite;
        this.handNode!.setPosition(startPosition);

        this.handTween = tween(this.handNode!)
            .delay(0.5)
            .call(() => {
                handSprite.spriteFrame = this.clickHandSprite!;
            })
            .delay(0.15)
            .to(1.5, { position: endPosition }, { easing: 'sineInOut' })
            .call(() => {
                handSprite.spriteFrame = this.idleHandSprite!;
            })
            .delay(0.5)
            .call(() => {
                // By the time this recursive call happens, the nodes might be gone.
                // We've added a check at the top of the function to handle this.
                this.runAnimationLoop(startNode, endNode)
            }) 
            .start();
    }
    
    private getUIPosition(targetNode: Node): Vec3 | null {
        const referenceNode = this.handNode?.parent;
        
        // --- ADDED SAFETY CHECK ---
        if (!referenceNode || !targetNode.isValid) return null;

        const refUIT = referenceNode.getComponent(UITransform);
        const targetUIT = targetNode.getComponent(UITransform);
        if (!refUIT || !targetUIT) return null;

        const worldPos = targetUIT.convertToWorldSpaceAR(v3(0, 0, 0));
        return refUIT.convertToNodeSpaceAR(worldPos);
    }
    // FILE: /assets/Scripts/TutorialController.ts
// Add this new function to your existing script. The rest of the file is unchanged.

public playClickTutorial(targetNode: Node): void {
    if (!this.handNode || !this.idleHandSprite || !this.clickHandSprite || !targetNode?.isValid) return;

    this.handNode.active = true;
    this.runClickAnimationLoop(targetNode);
}

private runClickAnimationLoop(targetNode: Node): void {
    const handSprite = this.handNode?.getComponent(Sprite);
    if (!handSprite || !targetNode.isValid) {
        this.stopTutorial();
        return;
    }

    const targetPosition = this.getUIPosition(targetNode);
    if (!targetPosition) {
        this.stopTutorial();
        return;
    }

    handSprite.spriteFrame = this.idleHandSprite;
    // Position hand slightly above and to the right of the target
    this.handNode!.setPosition(targetPosition.x + 20, targetPosition.y + 30, targetPosition.z);

    this.handTween = tween(this.handNode!)
        .delay(0.5)
        .call(() => { // "Press" down
            handSprite.spriteFrame = this.clickHandSprite!;
            tween(this.handNode).by(0.15, { position: new Vec3(0, -10, 0) }).start();
        })
        .delay(0.3)
        .call(() => { // "Release"
            handSprite.spriteFrame = this.idleHandSprite!;
             tween(this.handNode).by(0.15, { position: new Vec3(0, 10, 0) }).start();
        })
        .delay(0.5)
        .call(() => { // Loop the animation
            this.runClickAnimationLoop(targetNode);
        }) 
        .start();
}
}