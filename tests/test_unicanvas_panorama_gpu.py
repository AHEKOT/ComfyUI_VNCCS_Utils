"""Exercise the production panorama shader using native macOS OpenGL, without a browser.

Only the GLSL version/precision declarations are adapted to desktop GL. Other
platforms still run the portable projection and widget contract tests in Node.
"""
import ctypes as C
import math
from pathlib import Path
import re
import sys
import unittest

import numpy as np


class NativePanoramaGPU:
    def __init__(self):
        self.lib = C.CDLL("/System/Library/Frameworks/OpenGL.framework/OpenGL")
        self.functions = {}
        def function(name, result, *args):
            fn = getattr(self.lib, name)
            fn.restype = result
            fn.argtypes = args
            self.functions[name] = fn
            return fn
        self.fn = function
        choose = function("CGLChoosePixelFormat", C.c_int, C.POINTER(C.c_int), C.POINTER(C.c_void_p), C.POINTER(C.c_int))
        attributes = (C.c_int * 4)(99, 0x3200, 96, 0)  # Core 3.2, allow offline renderers.
        pixel_format, count = C.c_void_p(), C.c_int()
        if choose(attributes, C.byref(pixel_format), C.byref(count)) or not pixel_format:
            raise RuntimeError("No native OpenGL pixel format")
        self.context = C.c_void_p()
        create = function("CGLCreateContext", C.c_int, C.c_void_p, C.c_void_p, C.POINTER(C.c_void_p))
        error = create(pixel_format, None, C.byref(self.context))
        function("CGLDestroyPixelFormat", C.c_int, C.c_void_p)(pixel_format)
        if error:
            raise RuntimeError(f"Cannot create native OpenGL context: {error}")
        function("CGLSetCurrentContext", C.c_int, C.c_void_p)(self.context)
        u, i, p, f = C.c_uint, C.c_int, C.c_void_p, C.c_float
        for name, result, arguments in [
            ("glCreateShader", u, [u]), ("glShaderSource", None, [u, i, C.POINTER(C.c_char_p), C.POINTER(i)]),
            ("glCompileShader", None, [u]), ("glGetShaderiv", None, [u, u, C.POINTER(i)]),
            ("glGetShaderInfoLog", None, [u, i, C.POINTER(i), p]),
            ("glCreateProgram", u, []), ("glAttachShader", None, [u, u]), ("glLinkProgram", None, [u]),
            ("glGetProgramiv", None, [u, u, C.POINTER(i)]), ("glUseProgram", None, [u]),
            ("glGenVertexArrays", None, [i, C.POINTER(u)]), ("glBindVertexArray", None, [u]),
            ("glGenBuffers", None, [i, C.POINTER(u)]), ("glBindBuffer", None, [u, u]),
            ("glBufferData", None, [u, C.c_long, p, u]), ("glGetAttribLocation", i, [u, C.c_char_p]),
            ("glEnableVertexAttribArray", None, [u]), ("glVertexAttribPointer", None, [u, i, u, C.c_ubyte, i, p]),
            ("glGetUniformLocation", i, [u, C.c_char_p]), ("glUniform1i", None, [i, i]),
            ("glUniform3f", None, [i, f, f, f]), ("glUniform1f", None, [i, f]), ("glGenTextures", None, [i, C.POINTER(u)]),
            ("glActiveTexture", None, [u]), ("glBindTexture", None, [u, u]),
            ("glTexParameteri", None, [u, u, i]), ("glTexImage2D", None, [u, i, i, i, i, i, u, u, p]),
            ("glGenFramebuffers", None, [i, C.POINTER(u)]), ("glBindFramebuffer", None, [u, u]),
            ("glFramebufferTexture2D", None, [u, u, u, u, i]), ("glCheckFramebufferStatus", u, [u]),
            ("glViewport", None, [i, i, i, i]), ("glDrawArrays", None, [u, i, i]),
            ("glReadPixels", None, [i, i, i, i, u, u, p]), ("glDeleteTextures", None, [i, C.POINTER(u)]),
            ("glGetError", u, []),
        ]:
            function(name, result, *arguments)
        source = (Path(__file__).resolve().parents[1] / "web/vnccs_unicanvas_panorama.mjs").read_text()
        self.program = self.glCreateProgram()
        for name, kind in [("VERTEX", 0x8B31), ("FRAGMENT", 0x8B30)]:
            shader_source = re.search(rf"const {name} = `([\s\S]*?)`;", source)[1]
            shader_source = shader_source.replace("#version 300 es", "#version 150").replace("precision highp float;", "").encode()
            shader = self.glCreateShader(kind)
            pointer = C.c_char_p(shader_source)
            self.glShaderSource(shader, 1, C.byref(pointer), None)
            self.glCompileShader(shader)
            status = i()
            self.glGetShaderiv(shader, 0x8B81, C.byref(status))
            if not status.value:
                log = C.create_string_buffer(8192)
                self.glGetShaderInfoLog(shader, 8192, None, log)
                raise AssertionError(log.value.decode())
            self.glAttachShader(self.program, shader)
        self.glLinkProgram(self.program)
        status = i()
        self.glGetProgramiv(self.program, 0x8B82, C.byref(status))
        if not status.value:
            raise AssertionError("Panorama shader link failed")
        self.glUseProgram(self.program)
        vao, buffer = u(), u()
        self.glGenVertexArrays(1, C.byref(vao)); self.glBindVertexArray(vao)
        self.glGenBuffers(1, C.byref(buffer)); self.glBindBuffer(0x8892, buffer)
        vertices = np.array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1], dtype=np.float32)
        self.glBufferData(0x8892, vertices.nbytes, vertices.ctypes.data, 0x88E4)
        position = self.glGetAttribLocation(self.program, b"position")
        self.glEnableVertexAttribArray(position)
        self.glVertexAttribPointer(position, 2, 0x1406, 0, 0, None)
        self.framebuffer = u()
        self.glGenFramebuffers(1, C.byref(self.framebuffer))
        self.glBindFramebuffer(0x8D40, self.framebuffer)

    def __getattr__(self, name):
        return self.functions[name]

    def render(self, source, yaw=0, pitch=0, fov=90, side=64, before=None, after=None, roll=0):
        height, width = source.shape[:2] if before is not None else (side, side)
        textures = (C.c_uint * 4)()
        self.glGenTextures(4, textures)
        for index, pixels in enumerate([source, before if before is not None else source, after if after is not None else source, None]):
            self.glActiveTexture(0x84C0 + index)
            self.glBindTexture(0x0DE1, textures[index])
            self.glTexParameteri(0x0DE1, 0x2801, 0x2601)
            self.glTexParameteri(0x0DE1, 0x2800, 0x2601)
            self.glTexParameteri(0x0DE1, 0x2802, 0x2901 if index == 0 else 0x812F)
            self.glTexParameteri(0x0DE1, 0x2803, 0x812F)
            h, w = pixels.shape[:2] if pixels is not None else (height, width)
            pixels = np.ascontiguousarray(pixels) if pixels is not None else None
            self.glTexImage2D(0x0DE1, 0, 0x8058, w, h, 0, 0x1908, 0x1401, pixels.ctypes.data if pixels is not None else None)
        self.glFramebufferTexture2D(0x8D40, 0x8CE0, 0x0DE1, textures[3], 0)
        assert self.glCheckFramebufferStatus(0x8D40) == 0x8CD5
        for unit, name in enumerate([b"sphereImage", b"beforeImage", b"afterImage"]):
            self.glUniform1i(self.glGetUniformLocation(self.program, name), unit)
        self.glUniform1i(self.glGetUniformLocation(self.program, b"commitEdit"), before is not None)
        self.glUniform1f(self.glGetUniformLocation(self.program, b"cameraRoll"), math.radians(roll))
        self.glUniform3f(self.glGetUniformLocation(self.program, b"camera"), math.radians(yaw), math.radians(pitch), math.tan(math.radians(fov / 2)))
        self.glViewport(0, 0, width, height); self.glDrawArrays(0x0004, 0, 6)
        out = np.empty((height, width, 4), dtype=np.uint8)
        self.glReadPixels(0, 0, width, height, 0x1908, 0x1401, out.ctypes.data)
        error = self.glGetError()
        self.glDeleteTextures(4, textures)
        assert error == 0, f"OpenGL error {error}"
        return out[::-1].copy()

    def close(self):
        self.CGLSetCurrentContext(None)
        self.fn("CGLDestroyContext", C.c_int, C.c_void_p)(self.context)


@unittest.skipUnless(sys.platform == "darwin", "Native shader verification requires macOS OpenGL")
class PanoramaShaderTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.gpu = NativePanoramaGPU()

    @classmethod
    def tearDownClass(cls):
        cls.gpu.close()

    def source(self):
        y, x = np.mgrid[:128, :256]
        return np.stack([x, y * 2, np.full_like(x, 75), np.full_like(x, 255)], axis=-1).astype(np.uint8)

    def test_view_center_and_pitch_direction(self):
        for yaw, pitch in [(0, 0), (90, 0), (-90, 0), (0, 60), (0, -60)]:
            with self.subTest(yaw=yaw, pitch=pitch):
                view = self.gpu.render(self.source(), yaw=yaw, pitch=pitch, side=65)
                expected = np.array([(yaw / 360 + .5) * 256 - .5, (.5 - pitch / 180) * 256 - 1, 75, 255])
                np.testing.assert_allclose(view[32, 32], expected, atol=2)

    def test_unedited_view_does_not_resample_panorama(self):
        source = self.source()
        for yaw, pitch in [(0, 0), (180, 0), (145, 85), (-145, -85)]:
            view = self.gpu.render(source, yaw=yaw, pitch=pitch)
            result = self.gpu.render(source, yaw=yaw, pitch=pitch, before=view, after=view)
            np.testing.assert_array_equal(result, source)

    def test_edit_wraps_across_seam(self):
        source = self.source()
        before = self.gpu.render(source, yaw=180)
        after = before.copy(); after[20:44, 20:44] = [255, 0, 0, 255]
        result = self.gpu.render(source, yaw=180, before=before, after=after)
        self.assertTrue(np.any(np.all(result[:, :8] == [255, 0, 0, 255], axis=-1)))
        self.assertTrue(np.any(np.all(result[:, -8:] == [255, 0, 0, 255], axis=-1)))
        np.testing.assert_array_equal(result[:, 64:192], source[:, 64:192])
        returned = self.gpu.render(result, yaw=540)
        np.testing.assert_array_equal(returned[28:36, 28:36], after[28:36, 28:36])

    def test_roll_rotates_view_and_commits_edits_to_the_same_sphere(self):
        source = self.source()
        normal = self.gpu.render(source, yaw=150, pitch=35)
        rolled = self.gpu.render(source, yaw=150, pitch=35, roll=90)
        np.testing.assert_allclose(rolled, np.rot90(normal, -1), atol=1)
        unchanged = self.gpu.render(source, yaw=150, pitch=35, roll=90, before=rolled, after=rolled)
        np.testing.assert_array_equal(unchanged, source)
        after = rolled.copy(); after[20:44, 20:44] = [255, 0, 0, 255]
        edited = self.gpu.render(source, yaw=150, pitch=35, roll=90, before=rolled, after=after)
        returned = self.gpu.render(edited, yaw=150, pitch=35, roll=90)
        np.testing.assert_array_equal(returned[28:36, 28:36], after[28:36, 28:36])

    def test_eraser_and_poles(self):
        source = self.source()
        for pitch, row in [(90, 0), (-90, -1)]:
            view = self.gpu.render(source, pitch=pitch)
            after = view.copy(); after[16:48, 16:48] = 0
            result = self.gpu.render(source, pitch=pitch, before=view, after=after)
            self.assertTrue(np.all(result[row, :, 3] == 0))
            np.testing.assert_array_equal(result[64], source[64])


if __name__ == "__main__":
    unittest.main()
