import type { RenderCollisionEvent, RenderPoint, RenderSnapshot, RenderVehicle } from './types';

export interface CartoonPlayerLabel {
  name: string;
  color: string;
  place: number;
  stalled: boolean;
}

export interface CartoonFrame {
  snapshot: RenderSnapshot;
  /** Pixels per meter. */
  scale: number;
  players: ReadonlyMap<string, CartoonPlayerLabel>;
  /** Points shown floating above the at-fault car. */
  atFaultPenalty: number;
  /** Seconds, used for idle animation. */
  time: number;
  /** Screen x of the camera center in CSS pixels. Defaults to the middle of the canvas. */
  centerX?: number;
}

interface ScreenPoint {
  x: number;
  y: number;
}

const OUTLINE = '#1d1b2e';
const GRASS = '#7fd35a';
const GRASS_STRIPE = '#74c851';
const ASPHALT = '#565d6e';
const IMPACT_WORDS = ['POW!', 'BAM!', 'CRUNCH!', 'BONK!', 'WHAM!', 'KABLAM!', 'SMASH!'];
const TRAFFIC_TINTS = ['#c9d6e8', '#f4e3c1', '#d9c8f0', '#c6ecd9', '#f2cfcf', '#e6e6e6'];
export const CARTOON_FONT = '"Arial Rounded MT Bold", "Nunito", "Trebuchet MS", ui-rounded, system-ui, sans-serif';

/** Presenter renderer: road runs left to right with bold outlines and comic collision effects. */
export class CartoonRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private dpr = 1;
  private frame?: CartoonFrame;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('2D canvas rendering is not available.');
    this.ctx = context;
    this.resize();
  }

  get viewportWidth(): number {
    return this.width;
  }

  resize(): void {
    const bounds = this.canvas.getBoundingClientRect();
    this.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    this.width = Math.max(1, Math.floor(bounds.width));
    this.height = Math.max(1, Math.floor(bounds.height));
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** Grass-only frame for the lobby, before any race exists. */
  renderIdle(time: number): void {
    this.frame = undefined;
    const ctx = this.ctx;
    ctx.fillStyle = GRASS;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.fillStyle = GRASS_STRIPE;
    const offset = (time * 30) % 80;
    for (let x = -80 + offset; x < this.width; x += 80) ctx.fillRect(x, 0, 40, this.height);
  }

  render(frame: CartoonFrame): void {
    this.frame = frame;
    this.drawGrass();
    this.drawScenery(false);
    this.drawRoad();
    const vehicles = [...frame.snapshot.vehicles].sort((a, b) => Number(a.kind === 'ego') - Number(b.kind === 'ego'));
    for (const vehicle of vehicles) this.drawVehicle(vehicle);
    this.drawScenery(true);
    for (const event of frame.snapshot.collisionEvents) this.drawImpact(event);
    for (const vehicle of frame.snapshot.vehicles) {
      if (vehicle.kind === 'ego') this.drawPlayerTag(vehicle);
    }
  }

  private worldToScreen(point: RenderPoint): ScreenPoint {
    const { camera } = this.frame!.snapshot;
    const dx = point.x - camera.x;
    const dy = point.y - camera.y;
    const forward = Math.sin(camera.heading) * dx + Math.cos(camera.heading) * dy;
    const right = Math.cos(camera.heading) * dx - Math.sin(camera.heading) * dy;
    return {
      x: this.centerX + forward * this.frame!.scale,
      y: this.height / 2 + right * this.frame!.scale,
    };
  }

  private get centerX(): number {
    return this.frame?.centerX ?? this.width / 2;
  }

  private screenAngle(worldHeading: number): number {
    return worldHeading - this.frame!.snapshot.camera.heading;
  }

  private drawGrass(): void {
    const ctx = this.ctx;
    const { camera } = this.frame!.snapshot;
    const scale = this.frame!.scale;
    ctx.fillStyle = GRASS;
    ctx.fillRect(0, 0, this.width, this.height);

    // Mowing stripes are fixed in world space so they scroll with the camera.
    const stripe = 24;
    const cameraForward = Math.sin(camera.heading) * camera.x + Math.cos(camera.heading) * camera.y;
    const first = Math.floor((cameraForward - this.centerX / scale) / stripe);
    const last = Math.ceil((cameraForward + (this.width - this.centerX) / scale) / stripe);
    ctx.fillStyle = GRASS_STRIPE;
    for (let index = first; index <= last; index += 1) {
      if (index % 2 !== 0) continue;
      const x = this.centerX + (index * stripe - cameraForward) * scale;
      ctx.fillRect(x, 0, stripe * scale, this.height);
    }
  }

  private drawRoad(): void {
    const ctx = this.ctx;
    const { road } = this.frame!.snapshot;
    const scale = this.frame!.scale;
    const left = road.surface.left.map((point) => this.worldToScreen(point));
    const right = road.surface.right.map((point) => this.worldToScreen(point));

    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    // Dark outline, then curbs, then asphalt on top.
    for (const [points, width, color] of [
      [left, 2.6, OUTLINE],
      [right, 2.6, OUTLINE],
      [left, 1.7, '#ffffff'],
      [right, 1.7, '#ffffff'],
    ] as const) {
      strokePolyline(ctx, points, width * scale, color);
    }
    ctx.setLineDash([2.5 * scale, 2.5 * scale]);
    strokePolyline(ctx, left, 1.7 * scale, '#ef476f');
    strokePolyline(ctx, right, 1.7 * scale, '#ef476f');
    ctx.setLineDash([]);

    ctx.beginPath();
    tracePolyline(ctx, left);
    for (let index = right.length - 1; index >= 0; index -= 1) ctx.lineTo(right[index].x, right[index].y);
    ctx.closePath();
    ctx.fillStyle = ASPHALT;
    ctx.fill();

    for (const line of road.lines) {
      if (line.role !== 'lane') continue;
      const points = line.points.map((point) => this.worldToScreen(point));
      ctx.setLineDash([3 * scale, 4.5 * scale]);
      ctx.lineDashOffset = (line.dashOffsetMeters % 7.5) * scale;
      strokePolyline(ctx, points, Math.max(2, 0.28 * scale), '#fff6d5');
    }
    ctx.restore();
  }

  /** Trees and bushes placed by hashing stable road-side sample positions. */
  private drawScenery(canopy: boolean): void {
    const ctx = this.ctx;
    const scale = this.frame!.scale;
    const { surface } = this.frame!.snapshot.road;
    for (const [side, points, opposite] of [
      [-1, surface.left, surface.right],
      [1, surface.right, surface.left],
    ] as const) {
      for (let index = 0; index < Math.min(points.length, opposite.length); index += 1) {
        const point = points[index];
        const hash = hash2(Math.round(point.x * 2), Math.round(point.y * 2) + side * 7919);
        if (hash % 100 > 26) continue;
        // Push outward, away from the matching point on the far edge of the road.
        const awayX = point.x - opposite[index].x;
        const awayY = point.y - opposite[index].y;
        const length = Math.hypot(awayX, awayY) || 1;
        const normal = { x: awayX / length, y: awayY / length };
        const distance = 5 + ((hash >>> 8) % 1000) / 1000 * 26;
        const world = { x: point.x + normal.x * distance, y: point.y + normal.y * distance };
        const screen = this.worldToScreen(world);
        if (screen.x < -80 || screen.x > this.width + 80 || screen.y < -80 || screen.y > this.height + 80) continue;
        const size = (1.6 + ((hash >>> 4) % 100) / 100 * 2.2) * scale;
        const kind = (hash >>> 12) % 5;
        ctx.save();
        if (kind === 0) {
          if (!canopy) drawBush(ctx, screen, size * 0.7);
        } else if (!canopy) {
          ctx.fillStyle = 'rgba(29, 27, 46, 0.18)';
          ctx.beginPath();
          ctx.ellipse(screen.x + size * 0.35, screen.y + size * 0.4, size, size * 0.8, 0, 0, Math.PI * 2);
          ctx.fill();
        } else {
          drawTree(ctx, screen, size, (hash >>> 16) % 3);
        }
        ctx.restore();
      }
    }
  }

  private drawVehicle(vehicle: RenderVehicle): void {
    const ctx = this.ctx;
    const scale = this.frame!.scale;
    const center = this.worldToScreen(vehicle);
    const length = vehicle.length * scale;
    const width = vehicle.width * scale;
    if (center.x < -length * 2 || center.x > this.width + length * 2) return;
    const isPlayer = vehicle.kind === 'ego';
    const label = this.frame!.players.get(vehicle.id);
    const fill = isPlayer ? label?.color ?? vehicle.color : TRAFFIC_TINTS[hashString(vehicle.id) % TRAFFIC_TINTS.length];
    const truck = !isPlayer && vehicle.length > 6.2;

    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate(this.screenAngle(vehicle.heading));
    if (vehicle.collision) ctx.rotate(Math.sin(this.frame!.time * 60) * 0.06);

    // Drop shadow.
    ctx.fillStyle = 'rgba(29, 27, 46, 0.25)';
    roundRect(ctx, -length / 2 + 0.25 * scale, -width / 2 + 0.35 * scale, length, width, width * 0.35);
    ctx.fill();

    // Wheels.
    ctx.fillStyle = OUTLINE;
    const wheelLength = Math.max(3, 0.85 * scale);
    const wheelWidth = Math.max(2, 0.35 * scale);
    for (const along of [-0.3, 0.3]) {
      for (const across of [-1, 1]) {
        roundRect(ctx, along * length - wheelLength / 2, across * (width / 2) - wheelWidth / 2, wheelLength, wheelWidth, wheelWidth / 2);
        ctx.fill();
      }
    }

    // Body.
    ctx.lineWidth = Math.max(1.5, (isPlayer ? 0.32 : 0.22) * scale);
    ctx.strokeStyle = OUTLINE;
    ctx.fillStyle = vehicle.collision ? '#ff3b3b' : fill;
    roundRect(ctx, -length / 2, -width / 2, length, width, Math.min(width * 0.42, length * 0.25));
    ctx.fill();
    ctx.stroke();

    if (truck) {
      ctx.fillStyle = '#ffffff';
      roundRect(ctx, -length / 2 + 0.3 * scale, -width / 2 + 0.3 * scale, length * 0.66, width - 0.6 * scale, 0.3 * scale);
      ctx.fill();
      ctx.stroke();
    } else {
      // Roof and windshield.
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)';
      roundRect(ctx, -length * 0.2, -width * 0.32, length * 0.4, width * 0.64, width * 0.2);
      ctx.fill();
      ctx.fillStyle = '#a8e6ff';
      roundRect(ctx, length * 0.12, -width * 0.34, length * 0.16, width * 0.68, width * 0.12);
      ctx.fill();
      ctx.lineWidth = Math.max(1, 0.12 * scale);
      ctx.stroke();
    }

    if (isPlayer) {
      // Googly eyes on the hood.
      const eyeRadius = width * 0.17;
      for (const across of [-1, 1]) {
        const eyeX = length * 0.36;
        const eyeY = across * width * 0.2;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(eyeX, eyeY, eyeRadius, 0, Math.PI * 2);
        ctx.fill();
        ctx.lineWidth = Math.max(1, 0.1 * scale);
        ctx.stroke();
        ctx.fillStyle = OUTLINE;
        ctx.beginPath();
        ctx.arc(eyeX + eyeRadius * 0.35, eyeY + vehicle.actualSteering * eyeRadius * 0.4, eyeRadius * 0.5, 0, Math.PI * 2);
        ctx.fill();
      }
      // Brake lights.
      if (vehicle.actualMotor < -0.05) {
        ctx.fillStyle = '#ff2d55';
        for (const across of [-1, 1]) {
          ctx.beginPath();
          ctx.arc(-length / 2 + 0.2 * scale, across * width * 0.3, Math.max(2, 0.28 * scale), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  private drawPlayerTag(vehicle: RenderVehicle): void {
    const label = this.frame!.players.get(vehicle.id);
    if (!label) return;
    const ctx = this.ctx;
    const scale = this.frame!.scale;
    const center = this.worldToScreen(vehicle);
    if (center.x < -120 || center.x > this.width + 120) return;
    const fontSize = Math.round(Math.max(12, Math.min(20, scale * 1.5)));
    const text = label.place === 1 ? `👑 ${label.name}` : `${label.place}. ${label.name}`;
    ctx.save();
    ctx.font = `800 ${fontSize}px ${CARTOON_FONT}`;
    const textWidth = ctx.measureText(text).width;
    const tagWidth = textWidth + fontSize;
    const tagHeight = fontSize * 1.5;
    const tagX = center.x - tagWidth / 2;
    const tagY = center.y - vehicle.width * scale * 0.9 - tagHeight - 6;

    ctx.fillStyle = OUTLINE;
    ctx.beginPath();
    ctx.moveTo(center.x - 5, tagY + tagHeight - 1);
    ctx.lineTo(center.x + 5, tagY + tagHeight - 1);
    ctx.lineTo(center.x, tagY + tagHeight + 6);
    ctx.closePath();
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = OUTLINE;
    ctx.fillStyle = '#ffffff';
    roundRect(ctx, tagX, tagY, tagWidth, tagHeight, tagHeight / 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = label.color;
    roundRect(ctx, tagX + 3, tagY + tagHeight - 6, tagWidth - 6, 3, 1.5);
    ctx.fill();
    ctx.fillStyle = OUTLINE;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(text, center.x, tagY + tagHeight / 2 - 1);

    if (label.stalled) {
      // Dizzy stars orbiting the car.
      const t = this.frame!.time * 5;
      ctx.font = `${fontSize}px ${CARTOON_FONT}`;
      for (let index = 0; index < 3; index += 1) {
        const angle = t + (index * Math.PI * 2) / 3;
        ctx.fillText('⭐', center.x + Math.cos(angle) * vehicle.length * scale * 0.6, center.y + Math.sin(angle) * vehicle.width * scale * 0.9);
      }
    }
    ctx.restore();
  }

  private drawImpact(event: RenderCollisionEvent): void {
    const ctx = this.ctx;
    const scale = this.frame!.scale;
    const point = this.worldToScreen(event.point);
    if (point.x < -200 || point.x > this.width + 200) return;
    const progress = Math.min(1, event.age / event.duration);
    const pop = progress < 0.15 ? progress / 0.15 : 1 - Math.max(0, progress - 0.7) / 0.3;
    const radius = (3.2 + event.severity * 3.5) * scale * Math.max(0.05, pop) * (event.egoInvolved ? 1 : 0.6);
    const word = IMPACT_WORDS[hashString(event.id) % IMPACT_WORDS.length];

    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.rotate(((hashString(event.id) % 30) - 15) * (Math.PI / 180));
    ctx.beginPath();
    const spikes = 12;
    for (let index = 0; index <= spikes * 2; index += 1) {
      const angle = (index / (spikes * 2)) * Math.PI * 2;
      const r = index % 2 === 0 ? radius : radius * 0.62;
      if (index === 0) ctx.moveTo(Math.cos(angle) * r, Math.sin(angle) * r);
      else ctx.lineTo(Math.cos(angle) * r, Math.sin(angle) * r);
    }
    ctx.closePath();
    ctx.fillStyle = event.faultVehicleId && this.frame!.players.has(event.faultVehicleId) ? '#ffd23f' : '#ffffff';
    ctx.lineWidth = 4;
    ctx.strokeStyle = OUTLINE;
    ctx.fill();
    ctx.stroke();

    const fontSize = Math.max(10, radius * 0.5);
    ctx.font = `900 ${fontSize}px ${CARTOON_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ef233c';
    ctx.lineWidth = Math.max(2, fontSize * 0.12);
    ctx.strokeText(word, 0, 0);
    ctx.fillText(word, 0, 0);
    ctx.restore();

    const fault = event.faultVehicleId ? this.frame!.players.get(event.faultVehicleId) : undefined;
    const faultVehicle = this.frame!.snapshot.vehicles.find((vehicle) => vehicle.id === event.faultVehicleId);
    if (fault && faultVehicle && event.egoInvolved) {
      const at = this.worldToScreen(faultVehicle);
      const rise = progress * 50;
      ctx.save();
      ctx.globalAlpha = 1 - Math.max(0, progress - 0.6) / 0.4;
      ctx.font = `900 ${Math.max(16, scale * 2)}px ${CARTOON_FONT}`;
      ctx.textAlign = 'center';
      ctx.lineWidth = 5;
      ctx.strokeStyle = OUTLINE;
      ctx.fillStyle = '#ff4d6d';
      const text = `-${this.frame!.atFaultPenalty} AT FAULT`;
      const y = at.y - 3.5 * scale - 40 - rise;
      ctx.strokeText(text, at.x, y);
      ctx.fillText(text, at.x, y);
      ctx.restore();
    }
  }
}

function drawTree(ctx: CanvasRenderingContext2D, at: ScreenPoint, size: number, variant: number): void {
  const colors = ['#2f9e44', '#37b24d', '#2b8a3e'];
  ctx.lineWidth = Math.max(2, size * 0.12);
  ctx.strokeStyle = OUTLINE;
  ctx.fillStyle = colors[variant];
  ctx.beginPath();
  for (let index = 0; index < 6; index += 1) {
    const angle = (index / 6) * Math.PI * 2;
    const lobe = size * 0.48;
    ctx.moveTo(at.x + Math.cos(angle) * size * 0.55 + lobe, at.y + Math.sin(angle) * size * 0.55);
    ctx.arc(at.x + Math.cos(angle) * size * 0.55, at.y + Math.sin(angle) * size * 0.55, lobe, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(at.x, at.y, size * 0.7, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
  ctx.beginPath();
  ctx.arc(at.x - size * 0.3, at.y - size * 0.3, size * 0.32, 0, Math.PI * 2);
  ctx.fill();
}

function drawBush(ctx: CanvasRenderingContext2D, at: ScreenPoint, size: number): void {
  ctx.lineWidth = Math.max(1.5, size * 0.12);
  ctx.strokeStyle = OUTLINE;
  ctx.fillStyle = '#51cf66';
  ctx.beginPath();
  ctx.arc(at.x - size * 0.4, at.y, size * 0.5, 0, Math.PI * 2);
  ctx.arc(at.x + size * 0.4, at.y, size * 0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ff6b9a';
  ctx.beginPath();
  ctx.arc(at.x, at.y - size * 0.2, size * 0.14, 0, Math.PI * 2);
  ctx.fill();
}

function tracePolyline(ctx: CanvasRenderingContext2D, points: ScreenPoint[]): void {
  points.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
}

function strokePolyline(ctx: CanvasRenderingContext2D, points: ScreenPoint[], width: number, color: string): void {
  ctx.beginPath();
  tracePolyline(ctx, points);
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.stroke();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function hash2(a: number, b: number): number {
  let hash = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b ^ 0xc2b2ae35, 0x27d4eb2f);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2c1b3c6d);
  hash ^= hash >>> 12;
  return hash >>> 0;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
