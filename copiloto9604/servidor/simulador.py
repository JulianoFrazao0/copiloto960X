"""Robô de mentira para testar o Copiloto sem o robô de verdade.

Ele publica os mesmos tópicos que um robô típico publicaria (Field2d, FMSInfo,
Limelight, PathPlannerLib, SendableChooser, Alerts...) e, no autônomo, segue
as rotas do autônomo escolhido no seletor "Auto" — as mesmas que vocês
desenham na aba Autônomo.
"""

import json
import math
import random
import threading
import time
from pathlib import Path

DISABLED, AUTO, TELEOP = "disabled", "auto", "teleop"
CYCLE = [(DISABLED, 6.0), (AUTO, 20.0), (TELEOP, 140.0), (DISABLED, 8.0)]

LL = "/limelight"
SD = "/SmartDashboard"
FOV_H = math.radians(62.5)   # Limelight 3
FOV_V = math.radians(48.9)
CAM_HEIGHT = 0.50
CAM_PITCH = math.radians(20.0)
CAM_FORWARD = 0.30
MODULES = [(0.29, 0.29), (0.29, -0.29), (-0.29, 0.29), (-0.29, -0.29)]


def wrap(a):
    return (a + math.pi) % (2 * math.pi) - math.pi


def lerp_angle(a, b, t):
    return a + wrap(b - a) * t


# ---------------------------------------------------------------------------
# Rotas do PathPlanner (versão simplificada: perfil trapezoidal no comprimento)
# ---------------------------------------------------------------------------
def _bezier(p0, p1, p2, p3, t):
    u = 1 - t
    return (u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0],
            u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1])


class SimPath:
    def __init__(self, data, holonomic=True):
        wps = data.get("waypoints", [])
        pts = []  # (x, y, posição relativa ao waypoint)
        for i in range(len(wps) - 1):
            a, b = wps[i], wps[i + 1]
            p0 = (a["anchor"]["x"], a["anchor"]["y"])
            p3 = (b["anchor"]["x"], b["anchor"]["y"])
            nc = a.get("nextControl") or a["anchor"]
            pc = b.get("prevControl") or b["anchor"]
            p1 = (nc["x"], nc["y"])
            p2 = (pc["x"], pc["y"])
            for k in range(50):
                t = k / 50
                x, y = _bezier(p0, p1, p2, p3, t)
                pts.append((x, y, i + t))
        if wps:
            last = wps[-1]["anchor"]
            pts.append((last["x"], last["y"], float(len(wps) - 1)))
        self.pts = pts
        self.s = [0.0]
        for i in range(1, len(pts)):
            self.s.append(self.s[-1] + math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]))
        self.length = self.s[-1] if pts else 0.0
        c = data.get("globalConstraints") or {}
        self.vmax = max(0.2, float(c.get("maxVelocity", 3.0)))
        self.amax = max(0.2, float(c.get("maxAcceleration", 3.0)))
        start = (data.get("idealStartingState") or {}).get("rotation", 0.0)
        end = (data.get("goalEndState") or {}).get("rotation", 0.0)
        targets = [(0.0, math.radians(start or 0.0))]
        for rt in sorted(data.get("rotationTargets", []), key=lambda r: r.get("waypointRelativePos", 0)):
            targets.append((float(rt.get("waypointRelativePos", 0)), math.radians(rt.get("rotationDegrees", 0))))
        targets.append((float(max(len(wps) - 1, 0)), math.radians(end or 0.0)))
        self.rot_targets = targets
        self.holonomic = holonomic
        self.reversed = bool(data.get("reversed"))
        # tempo do perfil trapezoidal
        t_acc = self.vmax / self.amax
        d_acc = 0.5 * self.amax * t_acc ** 2
        if 2 * d_acc > self.length:
            t_acc = math.sqrt(self.length / self.amax) if self.length > 0 else 0.0
            self.vpeak = self.amax * t_acc
            self.t_cruise = 0.0
        else:
            self.vpeak = self.vmax
            self.t_cruise = (self.length - 2 * d_acc) / self.vmax
        self.t_acc = t_acc
        self.duration = 2 * t_acc + self.t_cruise

    def distance_at(self, t):
        a, ta, tc = self.amax, self.t_acc, self.t_cruise
        t = max(0.0, min(t, self.duration))
        if t < ta:
            return 0.5 * a * t * t
        d_acc = 0.5 * a * ta * ta
        if t < ta + tc:
            return d_acc + self.vpeak * (t - ta)
        td = t - ta - tc
        return d_acc + self.vpeak * tc + self.vpeak * td - 0.5 * a * td * td

    def sample(self, t):
        """Retorna (x, y, rot) no tempo t."""
        if not self.pts:
            return None
        d = self.distance_at(t)
        lo, hi = 0, len(self.s) - 1
        while lo < hi - 1:
            mid = (lo + hi) // 2
            if self.s[mid] <= d:
                lo = mid
            else:
                hi = mid
        seg = self.s[hi] - self.s[lo]
        f = 0.0 if seg <= 1e-9 else (d - self.s[lo]) / seg
        p, q = self.pts[lo], self.pts[hi]
        x = p[0] + (q[0] - p[0]) * f
        y = p[1] + (q[1] - p[1]) * f
        pos = p[2] + (q[2] - p[2]) * f
        if self.holonomic:
            rot = self.rot_targets[-1][1]
            for (p0, r0), (p1, r1) in zip(self.rot_targets, self.rot_targets[1:]):
                if p0 <= pos <= p1:
                    rot = lerp_angle(r0, r1, 0.0 if p1 - p0 < 1e-9 else (pos - p0) / (p1 - p0))
                    break
        else:
            rot = math.atan2(q[1] - p[1], q[0] - p[0]) + (math.pi if self.reversed else 0.0)
        return x, y, rot

    def poses(self, step=8):
        return [(p[0], p[1], 0.0) for p in self.pts[::step]]


def flatten_auto(cmd, out):
    """Transforma o comando do .auto numa lista simples de passos."""
    if not cmd:
        return out
    typ = cmd.get("type")
    data = cmd.get("data") or {}
    if typ == "path":
        out.append(("path", data.get("pathName")))
    elif typ == "wait":
        out.append(("wait", float(data.get("waitTime", 0))))
    elif typ == "named":
        out.append(("named", data.get("name")))
    elif typ in ("sequential", "parallel", "race", "deadline"):
        for c in data.get("commands", []):
            flatten_auto(c, out)
    return out


# ---------------------------------------------------------------------------
class FakeRobot:
    def __init__(self, data_dir, list_autos=None, load_auto=None, load_path=None):
        self.list_autos = list_autos or (lambda: [])
        self.load_auto = load_auto or (lambda n: None)
        self.load_path = load_path or (lambda n: None)
        tags_file = Path(data_dir) / "campos" / "rebuilt-2026.json"
        self.tags = []
        try:
            for tag in json.loads(tags_file.read_text("utf-8"))["tags"]:
                tr = tag["pose"]["translation"]
                q = tag["pose"]["rotation"]["quaternion"]
                yaw = math.atan2(2 * (q["W"] * q["Z"] + q["X"] * q["Y"]), 1 - 2 * (q["Y"] ** 2 + q["Z"] ** 2))
                self.tags.append((tag["ID"], tr["x"], tr["y"], tr["z"], yaw))
        except (OSError, KeyError, ValueError):
            pass
        self.t = 0.0
        self.cycle_t = 0.0
        self.cycle_i = 0
        self.x, self.y, self.rot = 3.4, 4.0, 0.0
        self.vx = self.vy = self.omega = 0.0
        self.drift = [0.0, 0.0, 0.0]
        self.gyro_total = 0.0
        self.hb = 0
        self.pipeline = 0
        self.led = 0
        self.cam_mode = 0
        self.priority_id = -1
        self.selected_auto = None
        self.auto_steps = []
        self.auto_i = 0
        self.auto_t = 0.0
        self.auto_path = None
        self.shooter_rpm = 0.0
        self.has_piece = True
        self.battery = 12.7
        self.climber = 0.0
        self.last_options = None
        self.teleop_phase = random.random() * 10

    # ---- escrita vinda do painel --------------------------------------
    def on_write(self, name, value):
        if name == SD + "/Auto/selected":
            self.selected_auto = str(value)
        elif name == LL + "/pipeline":
            self.pipeline = int(value)
        elif name == LL + "/ledMode":
            self.led = int(value)
        elif name == LL + "/camMode":
            self.cam_mode = int(value)
        elif name == LL + "/priorityid":
            self.priority_id = int(value)
        elif name == "/Copiloto/Sim/Modo" and value in (DISABLED, AUTO, TELEOP):
            # atalho do painel: pular direto para uma fase da partida
            self.cycle_i = next(i for i, (m, _) in enumerate(CYCLE) if m == value)
            self.cycle_t = 0.0
            self._enter_mode(value)
        elif name == "/Copiloto/ResetPose" and isinstance(value, list) and len(value) >= 3:
            self.x, self.y, self.rot = float(value[0]), float(value[1]), math.radians(float(value[2]))
            self.drift = [0.0, 0.0, 0.0]

    # ---- passo de simulação ------------------------------------------
    def mode(self):
        return CYCLE[self.cycle_i][0]

    def _enter_mode(self, mode):
        if mode == AUTO:
            self.auto_steps, self.auto_i, self.auto_t, self.auto_path = [], 0, 0.0, None
            name = self.selected_auto
            data = self.load_auto(name) if name else None
            if data:
                self.auto_steps = flatten_auto(data.get("command"), [])
                first = next((s for s in self.auto_steps if s[0] == "path"), None)
                if first and data.get("resetOdom", True):
                    pdata = self.load_path(first[1])
                    if pdata:
                        p = SimPath(pdata)
                        start = p.sample(0)
                        if start:
                            self.x, self.y, self.rot = start
                            self.drift = [0.0, 0.0, 0.0]
            self.has_piece = True

    def _run_auto(self, dt):
        """Executa os passos do auto. Retorna a velocidade desejada."""
        if self.auto_i >= len(self.auto_steps):
            return None
        kind, arg = self.auto_steps[self.auto_i]
        self.auto_t += dt
        if kind == "path":
            if self.auto_path is None:
                pdata = self.load_path(arg)
                self.auto_path = SimPath(pdata) if pdata else None
                if self.auto_path is None:
                    self.auto_i += 1
                    self.auto_t = 0.0
                    return None
            p = self.auto_path
            target = p.sample(self.auto_t)
            if self.auto_t >= p.duration:
                self.auto_i += 1
                self.auto_t = 0.0
                self.auto_path = None
            return ("pose", target)
        if kind == "wait":
            if self.auto_t >= arg:
                self.auto_i += 1
                self.auto_t = 0.0
            return None
        # comando nomeado: finge que leva 0,6 s (ex.: atirar, pegar peça)
        name = (arg or "").lower()
        if any(k in name for k in ("shoot", "atir", "lanc", "score")):
            self.shooter_rpm = 4200
            if self.auto_t > 0.4:
                self.has_piece = False
        if any(k in name for k in ("intake", "colet", "peg")):
            self.has_piece = True
        if self.auto_t >= 0.6:
            self.auto_i += 1
            self.auto_t = 0.0
        return None

    def step(self, dt):
        self.t += dt
        self.cycle_t += dt
        mode, dur = CYCLE[self.cycle_i]
        if self.cycle_t >= dur:
            self.cycle_t = 0.0
            self.cycle_i = (self.cycle_i + 1) % len(CYCLE)
            mode, dur = CYCLE[self.cycle_i]
            self._enter_mode(mode)

        px, py, prot = self.x, self.y, self.rot
        self.target_pose = None
        if mode == AUTO:
            cmd = self._run_auto(dt)
            if cmd and cmd[1]:
                tx, ty, trot = cmd[1]
                self.target_pose = (tx, ty, trot)
                self.x, self.y, self.rot = tx, ty, trot
        elif mode == TELEOP:
            tt = self.t * 0.6 + self.teleop_phase
            tx = 8.27 + 5.6 * math.sin(0.21 * tt)
            ty = 4.03 + 2.7 * math.sin(0.37 * tt + 0.7)
            mx, my = (tx - self.x) * min(1.0, dt * 2.5), (ty - self.y) * min(1.0, dt * 2.5)
            dist = math.hypot(mx, my)
            if dist > 4.0 * dt:  # limita a 4 m/s
                mx, my = mx / dist * 4.0 * dt, my / dist * 4.0 * dt
            self.x += mx
            self.y += my
            heading = math.atan2(ty - py, tx - px) if math.hypot(tx - px, ty - py) > 1e-4 else self.rot
            self.rot = lerp_angle(self.rot, heading, min(1.0, dt * 1.5))
            self.has_piece = (math.sin(tt * 0.8) > -0.2)
        self.vx = (self.x - px) / dt
        self.vy = (self.y - py) / dt
        self.omega = wrap(self.rot - prot) / dt
        self.gyro_total += wrap(self.rot - prot)
        speed = math.hypot(self.vx, self.vy)

        # deriva da odometria: anda junto com a velocidade e é corrigida pela visão
        self.drift[0] += random.gauss(0, 0.004) * speed * dt * 10
        self.drift[1] += random.gauss(0, 0.004) * speed * dt * 10
        self.drift[2] += random.gauss(0, 0.0015) * abs(self.omega) * dt * 10

        seen = self._visible_tags()
        if seen:
            self.drift = [d * (1 - min(1.0, dt * 0.8)) for d in self.drift]

        # subsistemas
        if mode == TELEOP:
            want = 3800 if self.has_piece else 1500
        elif mode == AUTO:
            want = max(self.shooter_rpm, 2500)
        else:
            want = 0
        self.shooter_rpm += (want - self.shooter_rpm) * min(1.0, dt * 3)
        load = speed * 0.35 + self.shooter_rpm / 4000 * 0.6
        self.battery += ((12.75 - load - (self.t / 3600.0)) - self.battery) * min(1.0, dt * 4)
        self.battery += random.gauss(0, 0.01)
        remaining = dur - self.cycle_t
        if mode == TELEOP and remaining < 30:
            self.climber = min(1.0, self.climber + dt * 0.12)
        elif mode != TELEOP:
            self.climber = max(0.0, self.climber - dt * 0.5)
        self.hb += 1
        return self._topics(mode, remaining, seen, speed)

    def _visible_tags(self):
        if self.cam_mode == 1:
            return []
        cx = self.x + CAM_FORWARD * math.cos(self.rot)
        cy = self.y + CAM_FORWARD * math.sin(self.rot)
        seen = []
        for tid, tx, ty, tz, tyaw in self.tags:
            dx, dy = tx - cx, ty - cy
            dist = math.hypot(dx, dy)
            if dist < 0.3 or dist > 6.0:
                continue
            # a tag precisa estar virada para a câmera
            if math.cos(tyaw) * -dx + math.sin(tyaw) * -dy <= 0.15 * dist:
                continue
            bearing = wrap(math.atan2(dy, dx) - self.rot)
            if abs(bearing) > FOV_H / 2:
                continue
            elev = math.atan2(tz - CAM_HEIGHT, dist) - CAM_PITCH
            if abs(elev) > FOV_V / 2:
                continue
            seen.append((tid, dist, bearing, elev))
        if self.priority_id >= 0:
            seen.sort(key=lambda s: (s[0] != self.priority_id, s[1]))
        else:
            seen.sort(key=lambda s: s[1])
        return seen

    def _topics(self, mode, remaining, seen, speed):
        out = []
        add = lambda n, t, v: out.append((n, t, v))
        enabled = mode != DISABLED
        ctrl = 0x20 | 0x10 | (0x01 if enabled else 0) | (0x02 if mode == AUTO else 0)
        add("/FMSInfo/.type", "string", "FMSInfo")
        add("/FMSInfo/FMSControlData", "int", ctrl)
        add("/FMSInfo/IsRedAlliance", "boolean", False)
        add("/FMSInfo/StationNumber", "int", 2)
        add("/FMSInfo/MatchNumber", "int", 12)
        add("/FMSInfo/MatchType", "int", 2)
        add("/FMSInfo/EventName", "string", "BRSP")
        add("/FMSInfo/GameSpecificMessage", "string", "")

        ox, oy, orot = self.x + self.drift[0], self.y + self.drift[1], self.rot + self.drift[2]
        add(SD + "/Field/.type", "string", "Field2d")
        add(SD + "/Field/Robot", "double[]", [ox, oy, math.degrees(orot)])
        add(SD + "/Match Time", "double", round(remaining, 2) if enabled else -1.0)
        add(SD + "/Bateria", "double", round(self.battery, 2))
        add(SD + "/Gyro/Yaw", "double", math.degrees(self.gyro_total))
        add(SD + "/Swerve/Velocidade", "double", speed)
        states = []
        c, s = math.cos(-orot), math.sin(-orot)
        vx_r, vy_r = self.vx * c - self.vy * s, self.vx * s + self.vy * c
        for mx, my in MODULES:
            mvx = vx_r - self.omega * my
            mvy = vy_r + self.omega * mx
            states.append({"speed": math.hypot(mvx, mvy), "angle": math.atan2(mvy, mvx)})
        add(SD + "/Swerve/Estados", "struct:SwerveModuleState[]", states)
        add(SD + "/Shooter/RPM", "double", round(self.shooter_rpm + random.gauss(0, 15), 1))
        add(SD + "/Shooter/RPM Alvo", "double", 3800.0 if mode == TELEOP else 0.0)
        add(SD + "/Shooter/Pronto", "boolean", abs(self.shooter_rpm - 3800) < 120)
        add(SD + "/Intake/Tem Peça", "boolean", self.has_piece)
        add(SD + "/Escalador/Posição", "double", round(self.climber, 3))
        add(SD + "/Escalador/Travado", "boolean", self.climber > 0.98)

        autos = ["Nada"] + list(self.list_autos())
        if autos != self.last_options:
            self.last_options = autos
            add(SD + "/Auto/.type", "string", "String Chooser")
            add(SD + "/Auto/options", "string[]", autos)
            add(SD + "/Auto/default", "string", "Nada")
        active = self.selected_auto if self.selected_auto in autos else "Nada"
        add(SD + "/Auto/active", "string", active)

        errors, warnings, infos = [], [], []
        if self.battery < 11.8:
            warnings.append(f"Bateria baixa: {self.battery:.1f} V")
        if not seen and enabled:
            infos.append("Limelight sem tags à vista")
        if mode == DISABLED and active == "Nada":
            warnings.append("Nenhum autônomo selecionado")
        add(SD + "/Alerts/.type", "string", "Alerts")
        add(SD + "/Alerts/errors", "string[]", errors)
        add(SD + "/Alerts/warnings", "string[]", warnings)
        add(SD + "/Alerts/infos", "string[]", infos)

        # Limelight
        latency = 11.0 + random.gauss(0, 1.2)
        cap = 4.5 + random.gauss(0, 0.4)
        add(LL + "/hb", "double", float(self.hb))
        add(LL + "/getpipe", "double", float(self.pipeline))
        add(LL + "/tl", "double", round(latency, 2))
        add(LL + "/cl", "double", round(cap, 2))
        add(LL + "/camerapose_robotspace", "double[]", [CAM_FORWARD, 0.0, CAM_HEIGHT, 0.0, math.degrees(CAM_PITCH), 0.0])
        if seen:
            tid, dist, bearing, elev = seen[0]
            add(LL + "/tv", "double", 1.0)
            add(LL + "/tx", "double", round(-math.degrees(bearing) + random.gauss(0, 0.15), 3))
            add(LL + "/ty", "double", round(math.degrees(elev) + random.gauss(0, 0.1), 3))
            add(LL + "/ta", "double", round(min(100.0, 2.5 / (dist * dist)), 4))
            add(LL + "/tid", "double", float(tid))
            n = len(seen)
            avg_dist = sum(s[1] for s in seen) / n
            noise = 0.02 + 0.015 * avg_dist / max(1, n)
            fid = []
            for t_id, d, b, e in seen:
                fid += [float(t_id), -math.degrees(b), math.degrees(e), 2.5 / (d * d), d, d + CAM_FORWARD,
                        round(min(1.0, 0.05 + 0.08 * d), 3)]
            # mesmo formato da Limelight de verdade: 7 números por tag vista
            add(LL + "/rawfiducials", "double[]", fid)
            span = 0.0
            if n > 1:
                span = max(s[1] for s in seen) - min(s[1] for s in seen) + 0.5
            for key, extra in (("botpose_wpiblue", 0.0), ("botpose_orb_wpiblue", -0.5)):
                k_noise = noise * (1 + extra)
                pose = [self.x + random.gauss(0, k_noise), self.y + random.gauss(0, k_noise), 0.0, 0.0, 0.0,
                        math.degrees(self.rot + random.gauss(0, 0.01)), latency + cap, float(n), span,
                        avg_dist, sum(2.5 / (s[1] ** 2) for s in seen) / n]
                add(LL + "/" + key, "double[]", pose + fid)
        else:
            add(LL + "/tv", "double", 0.0)
            add(LL + "/tx", "double", 0.0)
            add(LL + "/ty", "double", 0.0)
            add(LL + "/ta", "double", 0.0)
            add(LL + "/tid", "double", -1.0)
            add(LL + "/rawfiducials", "double[]", [])
            empty = [0.0] * 6 + [latency + cap, 0.0, 0.0, 0.0, 0.0]
            add(LL + "/botpose_wpiblue", "double[]", empty)
            add(LL + "/botpose_orb_wpiblue", "double[]", empty)

        # PathPlannerLib
        add("/PathPlanner/currentPose", "struct:Pose2d", {"x": ox, "y": oy, "rot": orot})
        if self.target_pose:
            tx, ty, trot = self.target_pose
            add("/PathPlanner/targetPose", "struct:Pose2d", {"x": tx, "y": ty, "rot": trot})
        if mode == AUTO and self.auto_path is not None:
            poses = [{"x": p[0], "y": p[1], "rot": 0.0} for p in self.auto_path.poses()]
            add("/PathPlanner/activePath", "struct:Pose2d[]", poses)
        elif mode != AUTO:
            add("/PathPlanner/activePath", "struct:Pose2d[]", [])
        return out


class SimBackend:
    """Fonte de dados interna: o FakeRobot escreve direto no Store (sem rede)."""
    kind = "sim"

    def __init__(self, store, robot):
        self.store = store
        self.robot = robot
        self._stop = threading.Event()
        self._thread = None

    def describe(self):
        return "Simulador interno"

    def start(self):
        self.store.set_status(fonte="sim", servidor=self.describe(), conectado=True, ip="simulado", erro=None)
        self._thread = threading.Thread(target=self._loop, name="simulador", daemon=True)
        self._thread.start()

    def _loop(self):
        dt = 0.02
        last = time.monotonic()
        while not self._stop.is_set():
            now = time.monotonic()
            step = min(0.1, now - last)
            last = now
            for name, typ, value in self.robot.step(max(step, 1e-3)):
                if self.store.get(name) != value:
                    self.store.update(name, typ, value)
            time.sleep(dt)

    def write(self, name, typ, value):
        self.robot.on_write(name, value)
        self.store.update(name, typ, value)

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=1)
