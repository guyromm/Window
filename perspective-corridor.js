// WebGL and 3D scene variables
let gl;
let program;
let positionLocation;
let colorLocation;
let mvpLocation;
let colorBuffer;
let interlacedLocation;
let eyePassLocation;
let isInterlacedMode = true;

// Stereoscopic settings
const EYE_SEPARATION = 6.5; // Average human IPD in cm

// Head tracking variables
let faceDetection;
let camera;
let isHeadTracking = false;
let baselineFaceWidth = null;
let calibratedDistance = 300; // Default 3m viewing distance

// Head position (in cm, relative to screen center)
// Will be initialized after constants are defined
let headPosition = { x: 0, y: 0, z: 300 }; // Default 3m viewing distance

// Smoothing variables for jitter reduction
const positionHistory = [];
const SMOOTHING_WINDOW_MS = 200; // 1/5 second averaging window
let lastPositionUpdateTime = Date.now();

let video;
let overlayCanvas;
let overlayCtx;

// Screen dimensions for 65" monitor (16:9 aspect ratio)
// 65" diagonal = 165.1 cm diagonal
// Width ≈ 143.9 cm, Height ≈ 80.9 cm
const SCREEN_WIDTH_CM = 143.9;
const SCREEN_HEIGHT_CM = 80.9;

// Camera offset from screen center (in cm)
// Camera is at the center-top of the display
// x = 0 (centered horizontally)
// y = 40.45cm (half of 80.9cm height - at the top edge)
const CAMERA_OFFSET_X = 0;  // Camera is centered horizontally
const CAMERA_OFFSET_Y = 40.45;  // Camera is at the top of screen (80.9/2)

// Initialize WebGL
function initWebGL() {
    const canvas = document.getElementById('glCanvas');
    gl = canvas.getContext('webgl');

    if (!gl) {
        alert('WebGL not supported');
        return false;
    }

    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);

    // Vertex shader
    const vertexShaderSource = `
        attribute vec3 position;
        attribute vec3 color;
        uniform mat4 mvpMatrix;
        varying vec3 vColor;

        void main() {
            gl_Position = mvpMatrix * vec4(position, 1.0);
            vColor = color;
        }
    `;

    // Fragment shader with interlaced stereo support
    const fragmentShaderSource = `
        precision mediump float;
        varying vec3 vColor;
        uniform bool interlaced;
        uniform int eyePass; // 0 for left eye, 1 for right eye
        uniform vec2 resolution;

        void main() {
            if (interlaced) {
                // Get the current pixel row
                float row = floor(gl_FragCoord.y);

                // Determine if this row should be rendered for current eye
                bool isEvenRow = mod(row, 2.0) < 0.5;

                if (eyePass == 1 && isEvenRow) {
                    // Right eye pass, even row - render in red
                    gl_FragColor = vec4(vColor.r, 0.0, 0.0, 1.0);
                } else if (eyePass == 0 && !isEvenRow) {
                    // Left eye pass, odd row - render in blue
                    gl_FragColor = vec4(0.0, 0.0, vColor.b, 1.0);
                } else {
                    // Skip this fragment
                    discard;
                }
            } else {
                // Normal rendering
                gl_FragColor = vec4(vColor, 1.0);
            }
        }
    `;

    // Create and compile shaders
    const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
    program = createProgram(gl, vertexShader, fragmentShader);

    if (!program) {
        console.error('Failed to create shader program');
        return false;
    }

    gl.useProgram(program);

    positionLocation = gl.getAttribLocation(program, 'position');
    colorLocation = gl.getAttribLocation(program, 'color');
    mvpLocation = gl.getUniformLocation(program, 'mvpMatrix');
    interlacedLocation = gl.getUniformLocation(program, 'interlaced');
    eyePassLocation = gl.getUniformLocation(program, 'eyePass');
    const resolutionLocation = gl.getUniformLocation(program, 'resolution');

    gl.enableVertexAttribArray(positionLocation);
    gl.enableVertexAttribArray(colorLocation);

    // Set the resolution uniform
    gl.uniform2f(resolutionLocation, canvas.width, canvas.height);

    colorBuffer = gl.createBuffer();

    return true;
}

function createShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader compilation error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createProgram(gl, vertexShader, fragmentShader) {
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Program linking error:', gl.getProgramInfoLog(program));
        gl.deleteProgram(program);
        return null;
    }
    return program;
}

// Matrix operations
function multiply(a, b) {
    const result = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            result[i * 4 + j] =
                a[i * 4 + 0] * b[0 * 4 + j] +
                a[i * 4 + 1] * b[1 * 4 + j] +
                a[i * 4 + 2] * b[2 * 4 + j] +
                a[i * 4 + 3] * b[3 * 4 + j];
        }
    }
    return result;
}

function createPerspectiveMatrix(left, right, bottom, top, near, far) {
    const matrix = new Float32Array(16);

    // Column 0
    matrix[0] = (2 * near) / (right - left);
    matrix[1] = 0;
    matrix[2] = 0;
    matrix[3] = 0;

    // Column 1
    matrix[4] = 0;
    matrix[5] = (2 * near) / (top - bottom);
    matrix[6] = 0;
    matrix[7] = 0;

    // Column 2 - this is where the asymmetric frustum shift happens
    matrix[8] = (right + left) / (right - left);
    matrix[9] = (top + bottom) / (top - bottom);
    matrix[10] = -(far + near) / (far - near);
    matrix[11] = -1;

    // Column 3
    matrix[12] = 0;
    matrix[13] = 0;
    matrix[14] = -(2 * far * near) / (far - near);
    matrix[15] = 0;

    return matrix;
}

function createViewMatrix(eyeX, eyeY, eyeZ) {
    // Translation matrix for camera position
    // In column-major order for OpenGL/WebGL
    return new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        eyeX, eyeY, eyeZ, 1
    ]);
}

function createPerspectiveCorrectedMatrix(headX, headY, headZ) {
    // The near plane should be at the screen distance
    // Also dampen Z-axis movement for consistency
    const dampedZ = 300 + (headZ - 300) * 0.5;  // Dampen changes from default 300cm
    const near = dampedZ;  // Near plane at viewer's distance from screen
    const far = dampedZ + 1000.0;  // Far plane extends beyond

    // Calculate the view frustum based on head position relative to screen
    // This creates the "window" effect where the screen acts as a portal
    // The screen dimensions define the frustum at the near plane
    // Reduced sensitivity - divide head movement by 2
    const dampingFactor = 0.5;
    const left = -SCREEN_WIDTH_CM/2 + headX * dampingFactor;
    const right = SCREEN_WIDTH_CM/2 + headX * dampingFactor;
    const bottom = -SCREEN_HEIGHT_CM/2 + headY * dampingFactor;
    const top = SCREEN_HEIGHT_CM/2 + headY * dampingFactor;

    // Debug log frustum values periodically
    if (!window.frustumLogCounter) window.frustumLogCounter = 0;
    if (window.frustumLogCounter++ % 60 === 0) {
        console.log('Frustum values:', {
            left: left.toFixed(3),
            right: right.toFixed(3),
            bottom: bottom.toFixed(3),
            top: top.toFixed(3),
            headX: headX.toFixed(1),
            headY: headY.toFixed(1),
            headZ: headZ.toFixed(1)
        });
    }

    return createPerspectiveMatrix(left, right, bottom, top, near, far);
}

function render() {
    gl.clearColor(0.1, 0.1, 0.2, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    if (!program) {
        console.error('No shader program available');
        return;
    }

    gl.useProgram(program);

    // Set interlaced mode uniform
    gl.uniform1i(interlacedLocation, isInterlacedMode ? 1 : 0);

    if (isInterlacedMode) {
        // Clear first for interlaced mode
        gl.clearColor(0.1, 0.1, 0.2, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // Render twice for stereoscopic vision
        // First pass: Left eye (blue channel, odd rows)
        gl.uniform1i(eyePassLocation, 0);
        renderEye(headPosition.x - EYE_SEPARATION/2, headPosition.y, headPosition.z);

        // Second pass: Right eye (red channel, even rows)
        // Don't clear between passes to preserve left eye render
        gl.uniform1i(eyePassLocation, 1);
        renderEye(headPosition.x + EYE_SEPARATION/2, headPosition.y, headPosition.z);
    } else {
        // Normal rendering - single pass
        gl.uniform1i(eyePassLocation, 0);
        renderEye(headPosition.x, headPosition.y, headPosition.z);
    }

    // Draw isometric debug view (using fixed corridor dimensions)
    drawIsometricDebugView(300, 200, -50, -800);
}

function renderEye(eyeX, eyeY, eyeZ) {
    // Create perspective projection matrix for this eye
    const projectionMatrix = createPerspectiveCorrectedMatrix(eyeX, eyeY, eyeZ);

    // Create view matrix - keep camera at screen (z=0)
    // The perspective effect comes entirely from the frustum
    const viewMatrix = createViewMatrix(0, 0, 0);

    // Corridor geometry scaled for 65" monitor and 3m viewing distance
    const corridorWidth = 300;  // Even wider corridor to ensure visibility
    const corridorHeight = 200;  // Taller corridor
    const corridorNear = -50;    // Move near wall in front of viewer
    const corridorFar = -800;    // Far wall much further away

    // Define all vertices for the corridor walls
    const vertices = [
        // Floor (blue) - vertices 0-3
        -corridorWidth/2, -corridorHeight/2, corridorNear,  // 0: near-left
         corridorWidth/2, -corridorHeight/2, corridorNear,  // 1: near-right
         corridorWidth/4, -corridorHeight/4, corridorFar,   // 2: far-right
        -corridorWidth/4, -corridorHeight/4, corridorFar,   // 3: far-left

        // Ceiling (yellow) - vertices 4-7
        -corridorWidth/2,  corridorHeight/2, corridorNear,  // 4: near-left
         corridorWidth/2,  corridorHeight/2, corridorNear,  // 5: near-right
         corridorWidth/4,  corridorHeight/4, corridorFar,   // 6: far-right
        -corridorWidth/4,  corridorHeight/4, corridorFar,   // 7: far-left

        // Left wall (brown) - vertices 8-11
        -corridorWidth/2, -corridorHeight/2, corridorNear,  // 8: near-bottom
        -corridorWidth/2,  corridorHeight/2, corridorNear,  // 9: near-top
        -corridorWidth/4,  corridorHeight/4, corridorFar,   // 10: far-top
        -corridorWidth/4, -corridorHeight/4, corridorFar,   // 11: far-bottom

        // Right wall (brown) - vertices 12-15
         corridorWidth/2, -corridorHeight/2, corridorNear,  // 12: near-bottom
         corridorWidth/2,  corridorHeight/2, corridorNear,  // 13: near-top
         corridorWidth/4,  corridorHeight/4, corridorFar,   // 14: far-top
         corridorWidth/4, -corridorHeight/4, corridorFar,   // 15: far-bottom

        // End wall (red) - vertices 16-19
        -corridorWidth/4, -corridorHeight/4, corridorFar,   // 16: bottom-left
         corridorWidth/4, -corridorHeight/4, corridorFar,   // 17: bottom-right
         corridorWidth/4,  corridorHeight/4, corridorFar,   // 18: top-right
        -corridorWidth/4,  corridorHeight/4, corridorFar    // 19: top-left
    ];

    // Define colors for each vertex (RGB)
    const colors = [
        // Floor (blue) - 4 vertices
        0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
        // Ceiling (yellow) - 4 vertices
        1, 1, 0,  1, 1, 0,  1, 1, 0,  1, 1, 0,
        // Left wall (brown) - 4 vertices
        0.5, 0.25, 0,  0.5, 0.25, 0,  0.5, 0.25, 0,  0.5, 0.25, 0,
        // Right wall (orange) - 4 vertices
        1, 0.5, 0,  1, 0.5, 0,  1, 0.5, 0,  1, 0.5, 0,
        // End wall (red) - 4 vertices
        1, 0, 0,  1, 0, 0,  1, 0, 0,  1, 0, 0
    ];

    // Define triangle indices for each wall
    const indices = [
        // Floor - 2 triangles
        0, 1, 2,  0, 2, 3,
        // Ceiling - 2 triangles
        4, 6, 5,  4, 7, 6,
        // Left wall - 2 triangles
        8, 9, 10,  8, 10, 11,
        // Right wall - 2 triangles
        12, 14, 13,  12, 15, 14,
        // End wall - 2 triangles
        16, 17, 18,  16, 18, 19
    ];

    // Create and bind position buffer
    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);

    // Create and bind color buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, colorBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(colors), gl.STATIC_DRAW);
    gl.vertexAttribPointer(colorLocation, 3, gl.FLOAT, false, 0, 0);

    // Combine projection and view matrices
    const mvpMatrix = multiply(projectionMatrix, viewMatrix);

    // Set MVP matrix
    gl.uniformMatrix4fv(mvpLocation, false, mvpMatrix);

    // Draw corridor walls
    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices), gl.STATIC_DRAW);

    // Debug: Log periodically to see what's happening
    if (!window.debugCounter) window.debugCounter = 0;
    if (window.debugCounter++ % 60 === 0) {  // Log every 60 frames (about once per second)
        console.log('Head position:', headPosition);
        console.log('First vertex:', vertices.slice(0, 3));
        console.log('Corridor dimensions:', { width: corridorWidth, height: corridorHeight, near: corridorNear, far: corridorFar });
        console.log('MVP Matrix first row:', mvpMatrix.slice(0, 4));
    }

    gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0);

    // Check for GL errors
    const error = gl.getError();
    if (error !== gl.NO_ERROR) {
        console.error('WebGL Error:', error);
    }

}

// Isometric debug view
let isometricCanvas;
let isometricCtx;

function drawIsometricDebugView(corridorWidth, corridorHeight, corridorNear, corridorFar) {
    if (!isometricCanvas) {
        isometricCanvas = document.getElementById('isometric-debug');
        isometricCtx = isometricCanvas.getContext('2d');
    }

    const ctx = isometricCtx;
    const width = isometricCanvas.width;
    const height = isometricCanvas.height;

    // Clear canvas
    ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.fillRect(0, 0, width, height);

    // Set up isometric transformation
    // Center of canvas
    const centerX = width / 2;
    const centerY = height / 2 + 50;

    // Scale factor to fit scene
    const scale = 0.3;

    // Isometric projection angles
    const angleX = Math.PI / 6; // 30 degrees
    const angleY = Math.PI / 4; // 45 degrees

    // Convert 3D to isometric 2D
    function toIsometric(x, y, z) {
        // Apply scale and isometric transformation
        const isoX = (x - z) * Math.cos(angleX) * scale;
        const isoY = ((x + z) * Math.sin(angleX) - y) * scale;
        return {
            x: centerX + isoX,
            y: centerY + isoY
        };
    }

    // Draw grid for reference
    ctx.strokeStyle = 'rgba(0, 255, 0, 0.2)';
    ctx.lineWidth = 0.5;
    for (let i = -200; i <= 200; i += 50) {
        const start = toIsometric(i, 0, -200);
        const end = toIsometric(i, 0, 200);
        ctx.beginPath();
        ctx.moveTo(start.x, start.y);
        ctx.lineTo(end.x, end.y);
        ctx.stroke();

        const start2 = toIsometric(-200, 0, i);
        const end2 = toIsometric(200, 0, i);
        ctx.beginPath();
        ctx.moveTo(start2.x, start2.y);
        ctx.lineTo(end2.x, end2.y);
        ctx.stroke();
    }

    // Draw corridor
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;

    // Near rectangle
    const nearCorners = [
        toIsometric(-corridorWidth/2, -corridorHeight/2, corridorNear),
        toIsometric(corridorWidth/2, -corridorHeight/2, corridorNear),
        toIsometric(corridorWidth/2, corridorHeight/2, corridorNear),
        toIsometric(-corridorWidth/2, corridorHeight/2, corridorNear)
    ];

    // Far rectangle
    const farCorners = [
        toIsometric(-corridorWidth/4, -corridorHeight/4, corridorFar),
        toIsometric(corridorWidth/4, -corridorHeight/4, corridorFar),
        toIsometric(corridorWidth/4, corridorHeight/4, corridorFar),
        toIsometric(-corridorWidth/4, corridorHeight/4, corridorFar)
    ];

    // Draw corridor edges
    ctx.beginPath();
    // Near rectangle
    ctx.moveTo(nearCorners[0].x, nearCorners[0].y);
    for (let i = 1; i < 4; i++) {
        ctx.lineTo(nearCorners[i].x, nearCorners[i].y);
    }
    ctx.closePath();
    ctx.stroke();

    // Far rectangle
    ctx.beginPath();
    ctx.moveTo(farCorners[0].x, farCorners[0].y);
    for (let i = 1; i < 4; i++) {
        ctx.lineTo(farCorners[i].x, farCorners[i].y);
    }
    ctx.closePath();
    ctx.stroke();

    // Connecting lines
    for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(nearCorners[i].x, nearCorners[i].y);
        ctx.lineTo(farCorners[i].x, farCorners[i].y);
        ctx.stroke();
    }

    // Draw viewport/screen (at z=0)
    ctx.strokeStyle = '#00ffff';
    ctx.lineWidth = 3;
    const screenCorners = [
        toIsometric(-SCREEN_WIDTH_CM/2, -SCREEN_HEIGHT_CM/2, 0),
        toIsometric(SCREEN_WIDTH_CM/2, -SCREEN_HEIGHT_CM/2, 0),
        toIsometric(SCREEN_WIDTH_CM/2, SCREEN_HEIGHT_CM/2, 0),
        toIsometric(-SCREEN_WIDTH_CM/2, SCREEN_HEIGHT_CM/2, 0)
    ];

    ctx.beginPath();
    ctx.moveTo(screenCorners[0].x, screenCorners[0].y);
    for (let i = 1; i < 4; i++) {
        ctx.lineTo(screenCorners[i].x, screenCorners[i].y);
    }
    ctx.closePath();
    ctx.stroke();

    // Draw viewer position
    const viewerPos = toIsometric(headPosition.x, headPosition.y, headPosition.z);

    // Draw viewer as a sphere
    ctx.fillStyle = '#ff0000';
    ctx.beginPath();
    ctx.arc(viewerPos.x, viewerPos.y, 8, 0, Math.PI * 2);
    ctx.fill();

    // Draw viewing frustum lines from viewer to screen corners
    ctx.strokeStyle = 'rgba(255, 0, 0, 0.3)';
    ctx.lineWidth = 1;
    for (let corner of screenCorners) {
        ctx.beginPath();
        ctx.moveTo(viewerPos.x, viewerPos.y);
        ctx.lineTo(corner.x, corner.y);
        ctx.stroke();
    }

    // Draw camera position
    const cameraPos = toIsometric(CAMERA_OFFSET_X, CAMERA_OFFSET_Y, 0);
    ctx.fillStyle = '#00ff00';
    ctx.beginPath();
    ctx.arc(cameraPos.x, cameraPos.y, 5, 0, Math.PI * 2);
    ctx.fill();

    // Draw labels
    ctx.fillStyle = '#00ff00';
    ctx.font = '10px monospace';
    ctx.fillText('Viewer', viewerPos.x + 10, viewerPos.y);
    ctx.fillText('Camera', cameraPos.x + 10, cameraPos.y);
    ctx.fillText('Screen', screenCorners[1].x + 5, screenCorners[1].y);

    // Draw position info
    ctx.fillStyle = '#ffff00';
    ctx.fillText(`X: ${headPosition.x.toFixed(0)}cm`, 10, 20);
    ctx.fillText(`Y: ${headPosition.y.toFixed(0)}cm`, 10, 35);
    ctx.fillText(`Z: ${headPosition.z.toFixed(0)}cm`, 10, 50);
}

// Head tracking functions
function initializeFaceDetection() {
    faceDetection = new FaceDetection({
        locateFile: (file) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`;
        }
    });

    faceDetection.setOptions({
        model: 'full',  // Changed from 'short' to 'full' for longer range detection
        minDetectionConfidence: 0.3,  // Lowered threshold for better distant detection
    });

    faceDetection.onResults(onFaceResults);

    camera = new Camera(video, {
        onFrame: async () => {
            if (isHeadTracking) {
                await faceDetection.send({image: video});
            }
        },
        width: 640,  // Increased resolution for better distant face detection
        height: 480
    });
}

function onFaceResults(results) {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    if (results.detections && results.detections.length > 0) {
        const detection = results.detections[0];
        const bbox = detection.boundingBox;
        lastDetectionBbox = bbox; // Store for calibration

        const faceX = bbox.xCenter * overlayCanvas.width;
        const faceY = bbox.yCenter * overlayCanvas.height;
        const faceWidth = bbox.width * overlayCanvas.width;
        const faceHeight = bbox.height * overlayCanvas.height;

        // Draw face detection
        overlayCtx.strokeStyle = '#00ff00';
        overlayCtx.lineWidth = 2;
        overlayCtx.strokeRect(
            faceX - faceWidth/2,
            faceY - faceHeight/2,
            faceWidth,
            faceHeight
        );

        // Update head position
        updateHeadPosition(faceX, faceY, faceWidth, faceHeight);
        document.getElementById('faceDetected').textContent = 'Yes';
    } else {
        document.getElementById('faceDetected').textContent = 'No';
        lastDetectionBbox = null;
    }
}

function updateHeadPosition(faceX, faceY, faceWidth, faceHeight) {
    const videoWidth = overlayCanvas.width;
    const videoHeight = overlayCanvas.height;
    const currentTime = Date.now();

    // Auto-calibrate on first detection if not already calibrated
    if (!baselineFaceWidth) {
        baselineFaceWidth = faceWidth;
        console.log('Auto-calibrated baseline face width:', baselineFaceWidth);
    }

    // Calculate raw position values
    const newDistance = (baselineFaceWidth / faceWidth) * calibratedDistance;
    const horizontalPixelOffset = faceX - (videoWidth / 2);
    const verticalPixelOffset = faceY - (videoHeight / 2);

    // Account for camera offset from screen center
    // The head position should be relative to screen center, not camera center
    // Reduced multiplier from 2.0 to 1.0 for more realistic head position mapping
    const rawX = (horizontalPixelOffset / videoWidth) * SCREEN_WIDTH_CM + CAMERA_OFFSET_X;
    const rawY = (verticalPixelOffset / videoHeight) * SCREEN_HEIGHT_CM + CAMERA_OFFSET_Y;

    // Add current position to history
    positionHistory.push({
        x: rawX,
        y: rawY,
        z: newDistance,
        timestamp: currentTime
    });

    // Remove old positions outside the smoothing window
    const cutoffTime = currentTime - SMOOTHING_WINDOW_MS;
    while (positionHistory.length > 0 && positionHistory[0].timestamp < cutoffTime) {
        positionHistory.shift();
    }

    // Calculate smoothed position using weighted average (newer samples have more weight)
    let totalWeight = 0;
    let smoothedX = 0, smoothedY = 0, smoothedZ = 0;

    positionHistory.forEach((pos, index) => {
        // Linear weight based on age (newer = higher weight)
        const age = currentTime - pos.timestamp;
        const weight = 1 - (age / SMOOTHING_WINDOW_MS);

        smoothedX += pos.x * weight;
        smoothedY += pos.y * weight;
        smoothedZ += pos.z * weight;
        totalWeight += weight;
    });

    // Apply smoothed values if we have enough data
    if (totalWeight > 0) {
        headPosition.x = smoothedX / totalWeight;
        headPosition.y = smoothedY / totalWeight;
        headPosition.z = smoothedZ / totalWeight;
    } else {
        // Fallback to raw values if no history
        headPosition.x = rawX;
        headPosition.y = rawY;
        headPosition.z = newDistance;
    }

    // Debug logging (less frequent)
    if (currentTime - lastPositionUpdateTime > 500) {  // Every 500ms
        console.log(`Head position - X: ${headPosition.x.toFixed(1)}cm, Y: ${headPosition.y.toFixed(1)}cm, Z: ${headPosition.z.toFixed(1)}cm`);
        console.log(`Raw offsets - X: ${horizontalPixelOffset.toFixed(0)}px, Y: ${verticalPixelOffset.toFixed(0)}px`);
        lastPositionUpdateTime = currentTime;
    }

    // Update display
    document.getElementById('headX').textContent = headPosition.x.toFixed(1);
    document.getElementById('headY').textContent = headPosition.y.toFixed(1);
    document.getElementById('headZ').textContent = headPosition.z.toFixed(1);
}

async function toggleHeadTracking() {
    if (!isHeadTracking) {
        try {
            // Start camera if not already started
            if (!camera._stream) {
                await camera.start();
            }

            // Wait for video to be ready
            if (video.videoWidth === 0 || video.videoHeight === 0) {
                await new Promise((resolve) => {
                    const checkVideo = () => {
                        if (video.videoWidth > 0 && video.videoHeight > 0) {
                            resolve();
                        } else {
                            setTimeout(checkVideo, 50);
                        }
                    };
                    checkVideo();
                });
            }

            overlayCanvas.width = video.videoWidth;
            overlayCanvas.height = video.videoHeight;

            isHeadTracking = true;
            document.getElementById('trackingStatus').textContent = 'On';
            document.getElementById('trackingBtn').textContent = 'Stop Head Tracking';
        } catch (err) {
            console.error('Failed to start camera:', err);
            document.getElementById('trackingStatus').textContent = 'Error';
        }
    } else {
        isHeadTracking = false;
        document.getElementById('trackingStatus').textContent = 'Off';
        document.getElementById('trackingBtn').textContent = 'Start Head Tracking';
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        // Don't stop the camera, just stop processing
    }
}

function calibrateDistance() {
    if (isHeadTracking && document.getElementById('faceDetected').textContent === 'Yes') {
        const userDistance = prompt('How far are you from the screen in cm?', '300');
        if (userDistance && !isNaN(userDistance)) {
            // Get current face width from the last detection
            const bbox = lastDetectionBbox;
            if (bbox) {
                const faceWidth = bbox.width * overlayCanvas.width;
                baselineFaceWidth = faceWidth;
                calibratedDistance = parseFloat(userDistance);
                headPosition.z = calibratedDistance;
                alert(`Distance calibrated to ${userDistance}cm`);
            }
        }
    } else {
        alert('Please start head tracking and ensure your face is detected first');
    }
}

function toggleInterlacedMode() {
    const checkbox = document.getElementById('interlacedMode');
    isInterlacedMode = checkbox.checked;
    console.log('Interlaced stereo mode:', isInterlacedMode ? 'ON' : 'OFF');
}

let lastDetectionBbox = null;

// Animation loop
function animate() {
    render();
    requestAnimationFrame(animate);
}

// Initialize everything
window.addEventListener('load', async function() {
    // Get DOM elements
    video = document.getElementById('video');
    overlayCanvas = document.getElementById('canvas-overlay');
    overlayCtx = overlayCanvas.getContext('2d');

    if (initWebGL()) {
        console.log('WebGL initialized successfully');
        initializeFaceDetection();
        animate();
        // Auto-start head tracking with workaround - simulate user clicking twice
        setTimeout(async () => {
            console.log('Auto-starting head tracking...');

            // First "click" - starts camera but tracking might not work yet
            await toggleHeadTracking();

            // Small delay, then simulate second "click" to ensure tracking works
            setTimeout(async () => {
                console.log('Ensuring tracking is fully active...');
                // Turn off
                await toggleHeadTracking();
                // Turn back on
                await toggleHeadTracking();
            }, 500);
        }, 500);
    } else {
        console.error('Failed to initialize WebGL');
    }
});

// Handle window resize
window.addEventListener('resize', function() {
    const canvas = document.getElementById('glCanvas');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);

    // Update resolution uniform for interlaced mode
    if (gl && program) {
        gl.useProgram(program);
        const resolutionLocation = gl.getUniformLocation(program, 'resolution');
        gl.uniform2f(resolutionLocation, canvas.width, canvas.height);
    }
});