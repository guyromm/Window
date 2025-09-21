// WebGL and 3D scene variables
let gl;
let program;
let positionLocation;
let colorLocation;
let mvpLocation;
let colorBuffer;

// Head tracking variables
let faceDetection;
let camera;
let isHeadTracking = false;
let baselineFaceWidth = null;
let calibratedDistance = 300; // Default 3m viewing distance

// Head position (in cm, relative to camera)
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
// Camera is 50cm below viewport center, 30cm from right edge
// So it's at: x = (143.9/2 - 30) = 41.95cm left of center
// y = -50cm below center
const CAMERA_OFFSET_X = 41.95;  // Camera is offset to the left from center
const CAMERA_OFFSET_Y = -50;    // Camera is below screen center

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

    // Fragment shader
    const fragmentShaderSource = `
        precision mediump float;
        varying vec3 vColor;

        void main() {
            gl_FragColor = vec4(vColor, 1.0);
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

    gl.enableVertexAttribArray(positionLocation);
    gl.enableVertexAttribArray(colorLocation);

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
    matrix[0] = (2 * near) / (right - left);
    matrix[1] = 0;
    matrix[2] = (right + left) / (right - left);
    matrix[3] = 0;
    matrix[4] = 0;
    matrix[5] = (2 * near) / (top - bottom);
    matrix[6] = (top + bottom) / (top - bottom);
    matrix[7] = 0;
    matrix[8] = 0;
    matrix[9] = 0;
    matrix[10] = -(far + near) / (far - near);
    matrix[11] = -(2 * far * near) / (far - near);
    matrix[12] = 0;
    matrix[13] = 0;
    matrix[14] = -1;
    matrix[15] = 0;
    return matrix;
}

function createViewMatrix(eyeX, eyeY, eyeZ) {
    // Translation matrix for camera position - moves the world opposite to head movement
    return new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        -eyeX, -eyeY, -eyeZ, 1
    ]);
}

function createPerspectiveCorrectedMatrix(headX, headY, headZ) {
    const near = 1.0;  // Closer near plane to see nearby geometry
    const far = 1000.0;  // Further far plane

    // For proper "window" perspective:
    // Moving head right should show more of the left side
    // Moving head away should make corridor appear farther/smaller

    // FIXED: Invert the Z relationship - use a reference distance with weaker effect
    const referenceZ = 300; // Reference distance matching default viewing distance
    const zEffect = 0.3; // Weaker Z effect (30% instead of 100%)
    const zScale = 1 + (referenceZ / headZ - 1) * zEffect; // Much weaker Z scaling

    // Calculate the view frustum based on head position relative to screen
    // Reduced amplification for larger screen - was too dramatic at 2.0
    const amplifiedHeadX = headX * 1.0; // Natural 1:1 lateral effect
    const amplifiedHeadY = headY * 1.0; // Natural 1:1 vertical effect

    const left = (-SCREEN_WIDTH_CM/2 + amplifiedHeadX) * near * zScale / referenceZ;
    const right = (SCREEN_WIDTH_CM/2 + amplifiedHeadX) * near * zScale / referenceZ;
    const bottom = (-SCREEN_HEIGHT_CM/2 - amplifiedHeadY) * near * zScale / referenceZ;  // Original was correct
    const top = (SCREEN_HEIGHT_CM/2 - amplifiedHeadY) * near * zScale / referenceZ;      // Original was correct

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

    // Create perspective projection matrix
    const projectionMatrix = createPerspectiveCorrectedMatrix(
        headPosition.x,
        headPosition.y,
        headPosition.z
    );

    // Create view matrix that moves the camera based on head position
    const viewMatrix = createViewMatrix(
        0,  // No X translation for now to debug
        0,  // No Y translation for now to debug
        0   // Keep camera at origin
    );

    // Corridor geometry scaled for 65" monitor and 3m viewing distance
    const corridorWidth = 200;  // Much wider corridor
    const corridorHeight = 150;  // Much taller corridor
    const corridorNear = 20;     // Start behind viewer (positive Z)
    const corridorFar = -500;    // Far wall much further away

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
        // Right wall (brown) - 4 vertices
        0.5, 0.25, 0,  0.5, 0.25, 0,  0.5, 0.25, 0,  0.5, 0.25, 0,
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
    if (currentTime - lastPositionUpdateTime > 100) {
        // console.log(`Smoothed position - X: ${headPosition.x.toFixed(1)}, Y: ${headPosition.y.toFixed(1)}, Z: ${headPosition.z.toFixed(1)}`);
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
});