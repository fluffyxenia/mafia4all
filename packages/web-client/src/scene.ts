import * as THREE from "three";
import type { ViewRosterEntry } from "./view-types.js";

// Per-player body color: a seat can set an explicit `color` (config.ts) to
// have full control for a video/stream; anyone without one cycles through
// this default palette in stable roster order instead. Heads use one fixed
// skin tone unless the game config also sets a face `icon` (an image URL/
// path/data-URI, or failing that an emoji/glyph rendered to a canvas —
// drawn over the head's front face) for that seat.
const OUTFIT_PALETTE = [0xdd4b4b, 0x4b8add, 0x4bdd7a, 0xddd24b, 0xa14bdd, 0xdd8f4b, 0x4bdadd, 0xdd4bb0];
const DEAD_OUTFIT = 0x3a3d4a;
// Icon planes use a MeshBasicMaterial, whose `color` multiplies the texture
// — full white leaves the icon at its original color, this dims/desaturates
// it toward grey without needing a second, separately-authored dead texture.
const ICON_TINT_ALIVE = 0xffffff;
const ICON_TINT_DEAD = 0x666666;

function resolveOutfitColor(entry: ViewRosterEntry, paletteIndex: number): number {
  if (!entry.alive) return DEAD_OUTFIT;
  if (entry.color) return new THREE.Color(entry.color).getHex();
  return OUTFIT_PALETTE[paletteIndex % OUTFIT_PALETTE.length]!;
}

// Where avatars sit, and how far out the head-level camera looks by default
// (see the Camera section below) — spaced out further than a first pass
// (2.8) so a close, head-level shot doesn't crowd neighboring avatars into
// frame together, and so panning between speakers reads as a clean turn
// rather than a blur of nearby bodies.
const CIRCLE_RADIUS = 4.5;
const CAMERA_HEIGHT = 1.55; // eye level for these avatars' proportions
// Continuous idle rotation used both for the lobby/post_game "spinning
// establishing shot" and as the fallback whenever there's no defined
// current speaker or turn-holder to point at (chiefly night phase, which
// has no single sequenced "turn" the way day discussion/voting do).
// Negative = counterclockwise as viewed from above; flip the sign if it
// visibly spins the wrong way once seen live.
const SPIN_RADIANS_PER_FRAME = -0.006;
const YAW_LERP = 0.08;
const MAX_FOCUS_HOLD_MS = 6500;

// Fixed, hand-placed background skyline — a ring of flat-shaded voxel
// buildings behind the player circle purely for atmosphere. This is
// deliberately just a plain data list (angle around the circle in radians,
// distance from center, footprint, height, color) so it's easy to hand-edit
// today and is exactly the shape of data a future standalone layout tool
// would read/write instead of this being buried in render code.
interface BuildingSpec {
  angle: number;
  radius: number;
  width: number;
  depth: number;
  height: number;
  color: number;
}
const BUILDING_LAYOUT: BuildingSpec[] = [
  { angle: 0.2, radius: 11, width: 2.2, depth: 2.2, height: 5.5, color: 0x2e3348 },
  { angle: 0.9, radius: 13, width: 3, depth: 2.4, height: 8, color: 0x262b40 },
  { angle: 1.6, radius: 10.5, width: 2, depth: 2, height: 4, color: 0x323a52 },
  { angle: 2.3, radius: 12.5, width: 2.6, depth: 2.6, height: 9.5, color: 0x232739 },
  { angle: 3.0, radius: 11.5, width: 2.2, depth: 2.2, height: 6.5, color: 0x2e3348 },
  { angle: 3.7, radius: 13.5, width: 3.2, depth: 2.4, height: 7, color: 0x262b40 },
  { angle: 4.4, radius: 10.5, width: 2, depth: 2, height: 4.5, color: 0x323a52 },
  { angle: 5.1, radius: 12, width: 2.4, depth: 2.4, height: 10, color: 0x232739 },
  { angle: 5.8, radius: 11, width: 2.2, depth: 2.2, height: 5, color: 0x2e3348 },
];

interface AvatarLimb {
  pivot: THREE.Group;
  mesh: THREE.Mesh;
  kind: "arm" | "leg";
}

interface Avatar {
  group: THREE.Group;
  head: THREE.Mesh;
  torso: THREE.Mesh;
  limbs: AvatarLimb[];
  icon?: THREE.Mesh;
  label: HTMLDivElement;
  baseY: number;
  talking: boolean;
  talkPhase: number;
  restLerp: number; // 0 = fully at rest, 1 = fully in talk pose; eases toward 0 after talking stops
}

// Warm dusk sky vs. a two-tone grass floor — deliberately opposite
// temperatures so the horizon reads clearly instead of the two blending
// into one mass.
const GROUND_TILE_A = "#4a7c3f";
const GROUND_TILE_B = "#3f6b36";
const SKY_TOP = "#161a30";
const SKY_HORIZON = "#7a5a6e";
const FOG_COLOR = 0x4a3a4a;

function makeGroundTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = GROUND_TILE_A;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = GROUND_TILE_B;
  ctx.fillRect(0, 0, size / 2, size / 2);
  ctx.fillRect(size / 2, size / 2, size / 2, size / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(10, 10);
  texture.magFilter = THREE.NearestFilter; // crisp pixelated tiles, matches the voxel look
  return texture;
}

/** An icon is an image (URL, path, or data URI) if it looks like one; anything else (an emoji, a short glyph) renders as text. */
function isImageIcon(icon: string): boolean {
  return /^(data:image\/|https?:\/\/|\.{0,2}\/)/.test(icon) || /\.(png|jpe?g|gif|webp|svg)$/i.test(icon);
}

function makeGlyphTexture(glyph: string): THREE.Texture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.font = `${size * 0.75}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, size / 2, size / 2 + size * 0.05);
  return new THREE.CanvasTexture(canvas);
}

function makeSkyTexture(): THREE.Texture {
  const canvas = document.createElement("canvas");
  canvas.width = 2;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, SKY_TOP);
  gradient.addColorStop(0.6, "#3d3350");
  gradient.addColorStop(1, SKY_HORIZON);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return new THREE.CanvasTexture(canvas);
}

/**
 * Voxel-styled spectator scene: blocky Minecraft-esque player figures (head
 * + torso + swinging arm/leg pivots, all box geometry) standing in a circle
 * inside a small voxel plaza, ringed by simple flat-shaded buildings for
 * atmosphere. Boxes stay cheap to draw on low-end hardware (Chromebooks,
 * Pis) while reading as far more "alive" than a single undifferentiated
 * cube per player. Player labels are DOM overlays projected onto screen
 * space each frame rather than in-scene sprites/text geometry, which is
 * both cheaper and crisper.
 */
export class GameScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private avatars = new Map<string, Avatar>();
  /**
   * Visual-only seat position per player id, randomized once per game
   * (recomputed only when the roster's id set actually changes) so
   * consecutively-submitted seats — e.g. several OpenRouter models from the
   * same provider, listed back to back in the config file — don't end up
   * sitting next to each other every single game. Deliberately independent
   * of playerId/roster order: those stay config-order-stable (see
   * host-main.ts) for reproducibility, this only ever affects where an
   * avatar physically sits in the circle.
   */
  private seatPosition = new Map<string, number>();
  private labelLayer: HTMLDivElement;
  private container: HTMLElement;
  private rafHandle: number | null = null;

  private textureLoader = new THREE.TextureLoader();
  /**
   * Camera lives at the circle's fixed center, at head height, and only
   * ever turns (yaw) rather than moves — "who's talking" reads as the
   * camera swiveling to face them, like a person standing among the
   * players, rather than swooping across the plaza. `camYaw` is the
   * current facing angle; it's either incremented directly (continuous
   * idle/lobby/post_game spin) or eased toward `speakingId`/`waitingOnId`'s
   * angle (see renderFrame) — never both, so a spin never "fights" a turn
   * toward a speaker.
   */
  private camYaw = 0;
  private phase = "lobby";
  private speakingId: string | undefined;
  private waitingOnId: string | undefined;
  private focusTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    // Capped for low-end/high-DPI hardware (Chromebooks, Pis) — rendering
    // at native devicePixelRatio on a 2x+ display is real GPU cost for no
    // visible gain on this style of low-poly scene.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    container.appendChild(this.renderer.domElement);

    this.scene.background = makeSkyTexture();
    this.scene.fog = new THREE.Fog(FOG_COLOR, 14, 30);

    this.labelLayer = document.createElement("div");
    this.labelLayer.style.position = "absolute";
    this.labelLayer.style.inset = "0";
    this.labelLayer.style.pointerEvents = "none";
    // container (#scene) is already `position: fixed` in index.html's
    // stylesheet, which is itself a valid containing block for this
    // absolutely-positioned layer — setting position here as an inline
    // style would win over that CSS rule (inline styles beat stylesheets)
    // and collapse the container to its content's intrinsic size, which
    // for an unsized <canvas> is the HTML default of 300×150.
    container.appendChild(this.labelLayer);

    this.camera = new THREE.PerspectiveCamera(48, 1, 0.1, 100);
    this.camera.position.set(0, CAMERA_HEIGHT, 0);
    this.camera.lookAt(this.yawLookAt(this.camYaw));

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(60, 60),
      new THREE.MeshLambertMaterial({ map: makeGroundTexture() }),
    );
    ground.rotation.x = -Math.PI / 2;
    this.scene.add(ground);

    this.buildSkyline();

    const sun = new THREE.DirectionalLight(0xfff2d9, 1.3);
    sun.position.set(4, 8, 5);
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0x40415a, 1.1));

    this.resize();
    window.addEventListener("resize", () => {
      this.resize();
      this.requestRender();
    });
  }

  private buildSkyline(): void {
    for (const b of BUILDING_LAYOUT) {
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(b.width, b.height, b.depth),
        new THREE.MeshLambertMaterial({ color: b.color }),
      );
      mesh.position.set(Math.cos(b.angle) * b.radius, b.height / 2, Math.sin(b.angle) * b.radius);
      this.scene.add(mesh);
    }
  }

  /** Loads an icon (an image URL/path/data-URI, or an emoji/glyph rendered to a canvas) as a face texture. */
  private loadIconTexture(icon: string): THREE.Texture {
    if (!isImageIcon(icon)) return makeGlyphTexture(icon);
    const texture = this.textureLoader.load(
      icon,
      () => this.requestRender(), // image loads asynchronously — repaint once it's actually in
      undefined,
      (err) => console.error(`failed to load avatar icon image "${icon}":`, err),
    );
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  }

  private resize(): void {
    const { clientWidth, clientHeight } = this.container;
    this.camera.aspect = clientWidth / Math.max(clientHeight, 1);
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(clientWidth, clientHeight);
  }

  /** One arm or leg: a pivot group at the joint, with the box offset downward inside it so rotation swings naturally. */
  private makeLimb(
    width: number,
    height: number,
    depth: number,
    jointY: number,
    x: number,
    color: number,
    kind: "arm" | "leg",
  ): AvatarLimb {
    const pivot = new THREE.Group();
    pivot.position.set(x, jointY, 0);
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), new THREE.MeshLambertMaterial({ color }));
    mesh.position.y = -height / 2;
    pivot.add(mesh);
    return { pivot, mesh, kind };
  }

  private makeAvatar(entry: ViewRosterEntry, outfitColor: number): Avatar {
    const group = new THREE.Group();

    const legPivotY = 0.75;
    const torsoH = 0.75;
    const headSize = 0.5;

    const torsoMat = new THREE.MeshLambertMaterial({ color: outfitColor });
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.5, torsoH, 0.28), torsoMat);
    torso.position.y = legPivotY + torsoH / 2;
    group.add(torso);

    // Head matches the body's outfit color (not a fixed skin tone) so a
    // player reads as one consistent color from head to toe; syncRoster
    // keeps this and the torso/limbs in lockstep as outfitColor changes
    // (including greying out together on death).
    const headMat = new THREE.MeshLambertMaterial({ color: outfitColor });
    const head = new THREE.Mesh(new THREE.BoxGeometry(headSize, headSize, headSize), headMat);
    head.position.y = legPivotY + torsoH + headSize / 2;
    group.add(head);

    let iconMesh: THREE.Mesh | undefined;
    if (entry.icon) {
      iconMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(headSize * 0.8, headSize * 0.8),
        new THREE.MeshBasicMaterial({ map: this.loadIconTexture(entry.icon), transparent: true, color: ICON_TINT_ALIVE }),
      );
      iconMesh.position.z = headSize / 2 + 0.01; // local +z is this avatar's front, set by its rotation.y below
      head.add(iconMesh);
    }

    const shoulderY = legPivotY + torsoH;
    const leftArm = this.makeLimb(0.22, 0.75, 0.22, shoulderY, -0.36, outfitColor, "arm");
    const rightArm = this.makeLimb(0.22, 0.75, 0.22, shoulderY, 0.36, outfitColor, "arm");
    const leftLeg = this.makeLimb(0.22, legPivotY, 0.22, legPivotY, -0.13, outfitColor, "leg");
    const rightLeg = this.makeLimb(0.22, legPivotY, 0.22, legPivotY, 0.13, outfitColor, "leg");
    const limbs = [leftArm, rightArm, leftLeg, rightLeg];
    for (const limb of limbs) group.add(limb.pivot);

    this.scene.add(group);

    const label = document.createElement("div");
    label.textContent = entry.displayName;
    label.style.position = "absolute";
    label.style.transform = "translate(-50%, -100%)";
    label.style.color = "#e8e8ec";
    label.style.fontSize = "0.75rem";
    label.style.fontFamily = "system-ui, sans-serif";
    label.style.textShadow = "0 1px 3px rgba(0,0,0,0.8)";
    label.style.whiteSpace = "nowrap";
    this.labelLayer.appendChild(label);

    return {
      group,
      head,
      torso,
      limbs,
      ...(iconMesh ? { icon: iconMesh } : {}),
      label,
      baseY: 0,
      talking: false,
      talkPhase: 0,
      restLerp: 0,
    };
  }

  /** (Re)randomizes seatPosition, but only when the roster's id set has actually changed — keeps seating stable across repeated syncRoster calls within one game. */
  private ensureSeatPositions(roster: ViewRosterEntry[]): void {
    const currentIds = roster.map((r) => r.id);
    const cachedIds = new Set(this.seatPosition.keys());
    const unchanged = currentIds.length === cachedIds.size && currentIds.every((id) => cachedIds.has(id));
    if (unchanged) return;

    const shuffled = [...currentIds];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    this.seatPosition = new Map(shuffled.map((id, i) => [id, i]));
  }

  /** Repositions avatars in a circle and adds/removes them to match the roster; recolors dead players. */
  syncRoster(roster: ViewRosterEntry[]): void {
    this.ensureSeatPositions(roster);
    const seen = new Set<string>();
    roster.forEach((entry, i) => {
      seen.add(entry.id);
      let avatar = this.avatars.get(entry.id);
      if (!avatar) {
        avatar = this.makeAvatar(entry, resolveOutfitColor(entry, this.avatars.size));
        this.avatars.set(entry.id, avatar);
      }
      // Seat position (where in the circle) is randomized per game and
      // independent of roster order; palette color below deliberately keeps
      // using the stable roster index `i`, not the shuffled seat, so outfit
      // colors stay tied to submission order the way resolveOutfitColor's
      // doc comment promises.
      const seatCount = Math.max(roster.length, 1);
      const seat = this.seatPosition.get(entry.id) ?? i;
      // Half-step offset (plus a base tilt toward the camera) keeps nobody
      // sitting exactly on the camera's forward axis, where they'd render
      // either right on top of the near clip plane or lost in the distance.
      const angle = (seat / seatCount) * Math.PI * 2 + Math.PI / seatCount + Math.PI;
      avatar.group.position.set(Math.cos(angle) * CIRCLE_RADIUS, 0, Math.sin(angle) * CIRCLE_RADIUS);
      // Local +z (where the face icon, if any, is mounted) needs to end up
      // pointing at the origin: rotating +z by this angle around Y lands it
      // at world (sin θ, cos θ), which we're solving to equal the unit
      // vector from this avatar's position back to the plaza's center.
      avatar.group.rotation.y = -angle - Math.PI / 2; // face the plaza's center
      avatar.baseY = avatar.group.position.y;

      const outfitColor = resolveOutfitColor(entry, i);
      (avatar.torso.material as THREE.MeshLambertMaterial).color.set(outfitColor);
      (avatar.head.material as THREE.MeshLambertMaterial).color.set(outfitColor);
      for (const limb of avatar.limbs) {
        (limb.mesh.material as THREE.MeshLambertMaterial).color.set(outfitColor);
      }
      if (avatar.icon) {
        (avatar.icon.material as THREE.MeshBasicMaterial).color.set(entry.alive ? ICON_TINT_ALIVE : ICON_TINT_DEAD);
      }
      avatar.group.rotation.z = entry.alive ? 0 : Math.PI / 2.2; // fallen over
      avatar.label.textContent = entry.alive ? entry.displayName : `${entry.displayName} †`;
    });

    for (const [id, avatar] of this.avatars) {
      if (!seen.has(id)) {
        this.scene.remove(avatar.group);
        avatar.label.remove();
        this.avatars.delete(id);
      }
    }
    this.requestRender();
  }

  /** Reports which phase the game is in — "lobby" and "post_game" get the idle spinning shot; every other phase turns to face a speaker/turn-holder instead. */
  setPhase(phase: string): void {
    this.phase = phase;
    this.requestRender();
  }

  /**
   * Reports who the game is currently waiting on to act (a day-discussion
   * or day-vote turn holder) — the camera turns to face them whenever
   * nobody's actively speaking, so a viewer sees who's "on the spot" while
   * that model is thinking. Pass undefined when there's no defined
   * turn-holder (e.g. night phase, which has no single sequenced turn) —
   * the camera falls back to its idle sweep in that case.
   */
  setWaitingOn(playerId: string | undefined): void {
    this.waitingOnId = playerId;
    this.requestRender();
  }

  /** Turns the camera to face one player, holding there until unfocus() or a safety timeout — call for the duration they're actually speaking. */
  focus(playerId: string): void {
    if (!this.avatars.has(playerId)) return;
    this.speakingId = playerId;

    if (this.focusTimeout) clearTimeout(this.focusTimeout);
    this.focusTimeout = setTimeout(() => this.unfocus(), MAX_FOCUS_HOLD_MS);
    this.requestRender();
  }

  /** Stops facing the current speaker — camera turns to the current turn-holder (if any) or resumes its idle sweep. */
  unfocus(): void {
    if (this.focusTimeout) {
      clearTimeout(this.focusTimeout);
      this.focusTimeout = null;
    }
    this.speakingId = undefined;
    this.requestRender();
  }

  /** World-space point to look at when facing angle `yaw`, from the camera's fixed position at the circle's center. */
  private yawLookAt(yaw: number): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(yaw) * CIRCLE_RADIUS, CAMERA_HEIGHT, Math.cos(yaw) * CIRCLE_RADIUS);
  }

  /** The yaw angle (from the circle's center) a given player sits at, or undefined if they're not currently seated. */
  private yawToPlayer(playerId: string): number | undefined {
    const avatar = this.avatars.get(playerId);
    if (!avatar) return undefined;
    return Math.atan2(avatar.group.position.x, avatar.group.position.z);
  }

  /** Starts the talk gesture (gentle arm sway + torso bob) for one player — call on TTS/utterance start. */
  startTalking(playerId: string): void {
    const avatar = this.avatars.get(playerId);
    if (!avatar) return;
    avatar.talking = true;
    this.requestRender();
  }

  /** Stops the talk gesture, easing back to rest — call on TTS/utterance end. */
  stopTalking(playerId: string): void {
    const avatar = this.avatars.get(playerId);
    if (avatar) avatar.talking = false;
  }

  private updateLabels(): void {
    const rect = this.container.getBoundingClientRect();
    const headWorld = new THREE.Vector3();
    const viewSpace = new THREE.Vector3();
    for (const avatar of this.avatars.values()) {
      avatar.head.getWorldPosition(headWorld);
      // Must check view-space depth (camera-local Z, negative = in front)
      // *before* the perspective divide inside project() below, not the
      // post-divide NDC z the old code checked. Found in real testing: any
      // avatar sitting near 90° off the camera's current facing direction
      // has view-space z near zero — project()'s divide-by-w blows up
      // there, catapulting the label to astronomical (garbage) pixel
      // coordinates, and post-divide NDC z doesn't reliably flag that
      // unstable zone as "behind camera" the way this raw check does.
      viewSpace.copy(headWorld).applyMatrix4(this.camera.matrixWorldInverse);
      if (viewSpace.z > -0.5) {
        avatar.label.style.display = "none";
        continue;
      }
      const projected = headWorld.clone().project(this.camera);
      const x = ((projected.x + 1) / 2) * rect.width;
      const y = ((1 - projected.y) / 2) * rect.height;
      avatar.label.style.display = "block";
      avatar.label.style.left = `${x}px`;
      avatar.label.style.top = `${y - 10}px`;
    }
  }

  /**
   * Render-on-demand rather than a continuous 60fps loop: on idle,
   * low-power hardware (the whole point of this hardware target —
   * Chromebooks, Pis) a static scene has no business keeping the GPU busy
   * every frame forever. A frame is only ever scheduled by requestRender(),
   * called from state changes and self-renewing only while a talk/camera
   * animation is actually in flight; otherwise the loop goes fully idle.
   * The one deliberate exception: the lobby/post_game/no-turn-holder idle
   * camera spin (see renderFrame) keeps the loop alive continuously by
   * design, since it never actually stops moving.
   */
  private renderRequested = false;

  private requestRender(): void {
    if (this.renderRequested) return;
    this.renderRequested = true;
    this.rafHandle = requestAnimationFrame(this.renderFrame);
  }

  private renderFrame = (): void => {
    this.renderRequested = false;
    let stillAnimating = false;

    // Camera never moves — it lives at the circle's fixed center, head
    // height — only ever turns. Priority: an actual speaker beats the
    // day-turn/vote-turn holder we're merely waiting on, which in turn
    // beats spinning; lobby/post_game always spin regardless of either.
    const spinning = this.phase === "lobby" || this.phase === "post_game";
    const facingId = spinning ? undefined : (this.speakingId ?? this.waitingOnId);
    const desiredYaw = facingId ? this.yawToPlayer(facingId) : undefined;
    if (desiredYaw === undefined) {
      // Also the fallback for phases with no defined single turn-holder
      // (chiefly night, which has no sequenced "whose turn is it") — keeps
      // the camera doing something rather than freezing on a stale target.
      this.camYaw += SPIN_RADIANS_PER_FRAME;
      stillAnimating = true;
    } else {
      let diff = desiredYaw - this.camYaw;
      diff = ((diff + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI; // wrap to [-PI, PI], shortest turn either way
      this.camYaw += diff * YAW_LERP;
      if (Math.abs(diff) > 0.002) stillAnimating = true;
    }
    this.camera.position.set(0, CAMERA_HEIGHT, 0);
    this.camera.lookAt(this.yawLookAt(this.camYaw));
    // updateLabels() below needs this frame's matrices, not last frame's —
    // renderer.render() normally refreshes them, but that happens after
    // updateLabels() runs each frame.
    this.camera.updateMatrixWorld();

    for (const avatar of this.avatars.values()) {
      const targetLerp = avatar.talking ? 1 : 0;
      avatar.restLerp += (targetLerp - avatar.restLerp) * 0.15;
      if (avatar.talking) avatar.talkPhase += 0.18;

      const arms = avatar.limbs.filter((l) => l.kind === "arm");
      if (Math.abs(avatar.restLerp - targetLerp) > 0.01 || avatar.talking) {
        stillAnimating = true;
        const sway = Math.sin(avatar.talkPhase) * 0.35 * avatar.restLerp;
        const bob = Math.abs(Math.sin(avatar.talkPhase * 0.5)) * 0.06 * avatar.restLerp;
        arms[0]!.pivot.rotation.x = sway;
        arms[1]!.pivot.rotation.x = -sway;
        avatar.group.position.y = avatar.baseY + bob;
        avatar.head.rotation.x = Math.sin(avatar.talkPhase * 0.7) * 0.08 * avatar.restLerp;
      } else {
        arms[0]!.pivot.rotation.x = 0;
        arms[1]!.pivot.rotation.x = 0;
        avatar.group.position.y = avatar.baseY;
        avatar.head.rotation.x = 0;
      }
    }

    this.updateLabels();
    this.renderer.render(this.scene, this.camera);
    if (stillAnimating) this.requestRender();
  };

  start(): void {
    this.requestRender();
  }

  dispose(): void {
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    if (this.focusTimeout) clearTimeout(this.focusTimeout);
    this.renderer.dispose();
  }
}
