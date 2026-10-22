"""Decodificação dos structs do WPILib que chegam como bytes pela NetworkTables.

Robôs que publicam com StructPublisher (ex.: Pose2d.struct, AdvantageKit,
PathPlannerLib) mandam o tipo "struct:Pose2d" com os campos em little-endian.
Aqui transformamos isso em dicionários simples para o navegador.
"""

import math
import struct

_TRANSLATION2D = struct.Struct("<2d")
_POSE2D = struct.Struct("<3d")
_POSE3D = struct.Struct("<7d")
_SPEEDS = struct.Struct("<3d")
_MODULE = struct.Struct("<2d")


def _yaw_from_quat(w, x, y, z):
    return math.atan2(2.0 * (w * z + x * y), 1.0 - 2.0 * (y * y + z * z))


def _pose2d(b):
    x, y, rot = _POSE2D.unpack(b)
    return {"x": x, "y": y, "rot": rot}


def _pose3d(b):
    x, y, z, qw, qx, qy, qz = _POSE3D.unpack(b)
    return {"x": x, "y": y, "z": z, "rot": _yaw_from_quat(qw, qx, qy, qz),
            "q": [qw, qx, qy, qz]}


def _translation2d(b):
    x, y = _TRANSLATION2D.unpack(b)
    return {"x": x, "y": y}


def _speeds(b):
    vx, vy, omega = _SPEEDS.unpack(b)
    return {"vx": vx, "vy": vy, "omega": omega}


def _module_state(b):
    speed, angle = _MODULE.unpack(b)
    return {"speed": speed, "angle": angle}


def _module_position(b):
    dist, angle = _MODULE.unpack(b)
    return {"distance": dist, "angle": angle}


def _rotation2d(b):
    return {"rot": struct.unpack("<d", b)[0]}


# nome do struct -> (tamanho em bytes, função de decodificação)
DECODERS = {
    "Pose2d": (24, _pose2d),
    "Transform2d": (24, _pose2d),
    "Twist2d": (24, lambda b: dict(zip(("dx", "dy", "dtheta"), _POSE2D.unpack(b)))),
    "Pose3d": (56, _pose3d),
    "Transform3d": (56, _pose3d),
    "Translation2d": (16, _translation2d),
    "Rotation2d": (8, _rotation2d),
    "ChassisSpeeds": (24, _speeds),
    "SwerveModuleState": (16, _module_state),
    "SwerveModulePosition": (16, _module_position),
}


def decode(type_str, data):
    """Retorna (tipo_simplificado, valor) ou None se não souber decodificar."""
    if not type_str.startswith("struct:"):
        return None
    name = type_str[len("struct:"):]
    is_array = name.endswith("[]")
    if is_array:
        name = name[:-2]
    dec = DECODERS.get(name)
    if dec is None:
        return None
    size, fn = dec
    try:
        if is_array:
            if len(data) % size:
                return None
            return [fn(data[i:i + size]) for i in range(0, len(data), size)]
        if len(data) != size:
            return None
        return fn(data)
    except struct.error:
        return None


_ENCODERS = {
    "Pose2d": lambda v: _POSE2D.pack(v["x"], v["y"], v["rot"]),
    "SwerveModuleState": lambda v: _MODULE.pack(v["speed"], v["angle"]),
    "ChassisSpeeds": lambda v: _SPEEDS.pack(v["vx"], v["vy"], v["omega"]),
}


def encode(type_str, value):
    """Inverso de decode() para os structs que o robô simulado publica."""
    name = type_str[len("struct:"):]
    if name.endswith("[]"):
        fn = _ENCODERS[name[:-2]]
        return b"".join(fn(v) for v in value)
    return _ENCODERS[name](value)
