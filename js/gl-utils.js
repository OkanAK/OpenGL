/*
 * gl-utils.js — thin WebGL helpers.
 *
 * A minimal batched "immediate mode": build colored triangle geometry on the
 * CPU into a Float32Array of [x, y, r, g, b, a] vertices, upload once per
 * frame, draw. Enough to render a gauge and a chart without pulling in a
 * whole engine, and it keeps the OpenGL/WebGL nature of the project honest.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GLU = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERTEX_SRC = `
    attribute vec2 a_pos;      // pixel coords (top-left origin)
    attribute vec4 a_color;
    uniform vec2 u_resolution; // canvas size in pixels
    varying vec4 v_color;
    void main() {
      vec2 clip = (a_pos / u_resolution) * 2.0 - 1.0;
      gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0); // flip Y to top-left origin
      v_color = a_color;
    }`;

  const FRAGMENT_SRC = `
    precision mediump float;
    varying vec4 v_color;
    void main() { gl_FragColor = v_color; }`;

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('shader compile failed: ' + log);
    }
    return sh;
  }

  function createProgram(gl) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERTEX_SRC));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error('program link failed: ' + gl.getProgramInfoLog(p));
    }
    return p;
  }

  const FLOATS_PER_VERTEX = 6; // x, y, r, g, b, a

  /** Accumulates triangle vertices, then flushes them to the GPU in one draw. */
  class Batch {
    constructor() { this.data = []; }
    clear() { this.data.length = 0; }

    // Push one triangle. Each vertex: [x,y]; color is [r,g,b,a] in 0..1.
    tri(ax, ay, bx, by, cx, cy, color) {
      const d = this.data, c = color;
      d.push(ax, ay, c[0], c[1], c[2], c[3]);
      d.push(bx, by, c[0], c[1], c[2], c[3]);
      d.push(cx, cy, c[0], c[1], c[2], c[3]);
    }

    // Axis-aligned quad from two corners.
    quad(x0, y0, x1, y1, color) {
      this.tri(x0, y0, x1, y0, x1, y1, color);
      this.tri(x0, y0, x1, y1, x0, y1, color);
    }

    // Thick line segment as a quad, given endpoints and half-width.
    thickLine(x0, y0, x1, y1, halfWidth, color) {
      let dx = x1 - x0, dy = y1 - y0;
      const len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len * halfWidth, ny = dx / len * halfWidth;
      this.tri(x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, color);
      this.tri(x0 + nx, y0 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny, color);
    }

    /**
     * Ring segment (annulus wedge) from angle a0 to a1 (radians, screen space
     * where +x is right, +y is down). Used for the gauge's colored zones.
     */
    arc(cx, cy, rInner, rOuter, a0, a1, color, segments) {
      segments = segments || Math.max(2, Math.ceil(Math.abs(a1 - a0) / 0.08));
      const step = (a1 - a0) / segments;
      for (let i = 0; i < segments; i++) {
        const t0 = a0 + step * i, t1 = a0 + step * (i + 1);
        const c0 = Math.cos(t0), s0 = Math.sin(t0);
        const c1 = Math.cos(t1), s1 = Math.sin(t1);
        const ix0 = cx + c0 * rInner, iy0 = cy + s0 * rInner;
        const ox0 = cx + c0 * rOuter, oy0 = cy + s0 * rOuter;
        const ix1 = cx + c1 * rInner, iy1 = cy + s1 * rInner;
        const ox1 = cx + c1 * rOuter, oy1 = cy + s1 * rOuter;
        this.tri(ix0, iy0, ox0, oy0, ox1, oy1, color);
        this.tri(ix0, iy0, ox1, oy1, ix1, iy1, color);
      }
    }

    /** Filled circle, for the needle hub and data dots. */
    disc(cx, cy, r, color, segments) {
      segments = segments || 24;
      const step = (Math.PI * 2) / segments;
      for (let i = 0; i < segments; i++) {
        const t0 = step * i, t1 = step * (i + 1);
        this.tri(cx, cy,
          cx + Math.cos(t0) * r, cy + Math.sin(t0) * r,
          cx + Math.cos(t1) * r, cy + Math.sin(t1) * r, color);
      }
    }
  }

  /** Parse '#rrggbb' (or with alpha) into a normalized [r,g,b,a] array. */
  function hexColor(hex, alpha) {
    const h = hex.replace('#', '');
    return [
      parseInt(h.substr(0, 2), 16) / 255,
      parseInt(h.substr(2, 2), 16) / 255,
      parseInt(h.substr(4, 2), 16) / 255,
      alpha == null ? 1 : alpha,
    ];
  }

  /** A ready-to-draw context: manages the program, buffer and one draw call. */
  class Context {
    constructor(canvas) {
      const gl = canvas.getContext('webgl', { antialias: true, alpha: true })
        || canvas.getContext('experimental-webgl');
      if (!gl) throw new Error('WebGL is not available in this browser');
      this.gl = gl;
      this.canvas = canvas;
      this.program = createProgram(gl);
      this.buffer = gl.createBuffer();
      this.a_pos = gl.getAttribLocation(this.program, 'a_pos');
      this.a_color = gl.getAttribLocation(this.program, 'a_color');
      this.u_resolution = gl.getUniformLocation(this.program, 'u_resolution');
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    /** Resize backing store to CSS size * devicePixelRatio. Returns [w,h] CSS px. */
    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
      this.canvas.width = Math.max(1, Math.round(w * dpr));
      this.canvas.height = Math.max(1, Math.round(h * dpr));
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
      this._dpr = dpr;
      return [w, h];
    }

    clear(color) {
      const c = color || [0, 0, 0, 0];
      this.gl.clearColor(c[0], c[1], c[2], c[3]);
      this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    }

    draw(batch) {
      const gl = this.gl;
      const verts = new Float32Array(batch.data);
      gl.useProgram(this.program);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
      // Uniform is in device pixels because a_pos is scaled by DPR at draw time.
      gl.uniform2f(this.u_resolution, this.canvas.width, this.canvas.height);
      const stride = FLOATS_PER_VERTEX * 4;
      gl.enableVertexAttribArray(this.a_pos);
      gl.vertexAttribPointer(this.a_pos, 2, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(this.a_color);
      gl.vertexAttribPointer(this.a_color, 4, gl.FLOAT, false, stride, 2 * 4);
      gl.drawArrays(gl.TRIANGLES, 0, verts.length / FLOATS_PER_VERTEX);
    }

    get dpr() { return this._dpr || 1; }
  }

  return { Context, Batch, hexColor, FLOATS_PER_VERTEX };
});
