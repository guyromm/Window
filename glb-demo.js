// Import Three.js modules
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// Three.js scene variables
let scene, camera, renderer;
let boxMesh, modelMesh;
let ambientLight, directionalLight;
let isInterlacedMode = false;

// GLB model variables
let currentModel = null;
let modelScale = 1.0;
let modelRotationY = 270 * Math.PI / 180; // Default 270 degrees
let modelPositionX = 0;
let modelPositionY = 0;
let modelPositionZ = -15;

// Head tracking variables
let faceDetection;
let cameraUtils;
let isHeadTracking = false;
let baselineFaceWidth = null;
let calibratedDistance = 40; // Default 40cm viewing distance
let headPosition = { x: 0, y: 0, z: 40 };
let lastValidHeadPosition = { x: 0, y: 0, z: 40 };
let hasTrackedAtLeastOnce = false;

// Smoothing variables
const positionHistory = [];
const SMOOTHING_WINDOW_MS = 200;
let lastPositionUpdateTime = Date.now();

let video;
let overlayCanvas;
let overlayCtx;

// Screen dimensions (14" laptop)
const SCREEN_WIDTH_CM = 30.9;
const SCREEN_HEIGHT_CM = 17.4;

// Camera offset from screen center
const CAMERA_OFFSET_X = 0;
const CAMERA_OFFSET_Y = 8.7;

// Box dimensions
const BOX_WIDTH = SCREEN_WIDTH_CM;
const BOX_HEIGHT = SCREEN_HEIGHT_CM;
const BOX_DEPTH = 20;  // Reduced to 10cm for better proportions (was 30)

// Initialize Three.js scene
function initThreeJS() {
    // Create scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a14);

    // Create camera with proper FOV
    const aspect = window.innerWidth / window.innerHeight;
    camera = new THREE.PerspectiveCamera(50, aspect, 0.1, 1000);
    camera.position.set(0, 0, headPosition.z);

    // Create renderer
    renderer = new THREE.WebGLRenderer({
        canvas: document.getElementById('glCanvas'),
        antialias: true
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // Add lights
    ambientLight = new THREE.AmbientLight(0xffffff, 0.3);
    scene.add(ambientLight);

    directionalLight = new THREE.DirectionalLight(0xffffff, 1);
    directionalLight.position.set(0, 10, 20);
    directionalLight.castShadow = true;
    directionalLight.shadow.camera.left = -50;
    directionalLight.shadow.camera.right = 50;
    directionalLight.shadow.camera.top = 50;
    directionalLight.shadow.camera.bottom = -50;
    scene.add(directionalLight);

    // Create the perspective box
    createPerspectiveBox();

    // Load the default GLB model
    //loadGLBModel('dodge_charger_with_doors_open.glb');
    loadGLBModel('oldmodelzaz.glb');

    // Set up controls
    setupControls();
}

// Create the wireframe perspective box
function createPerspectiveBox() {
    // CRITICAL: Create the box with its near face at z=0 (the screen plane)
    // Only draw the edges that connect from screen corners into the depth

    const vertices = [];
    const indices = [];

    // Define the 8 corners of the box
    // Convert from cm to scene units (1 unit = 10cm)
    const sceneScale = 10;
    const halfWidth = BOX_WIDTH / sceneScale / 2;
    const halfHeight = BOX_HEIGHT / sceneScale / 2;
    const boxDepthInUnits = BOX_DEPTH / sceneScale;

    // Near face vertices (at z=0, the screen plane)
    vertices.push(-halfWidth, -halfHeight, 0);  // 0: bottom-left
    vertices.push(halfWidth, -halfHeight, 0);   // 1: bottom-right
    vertices.push(halfWidth, halfHeight, 0);    // 2: top-right
    vertices.push(-halfWidth, halfHeight, 0);   // 3: top-left

    // Far face vertices
    vertices.push(-halfWidth, -halfHeight, -boxDepthInUnits);  // 4: bottom-left
    vertices.push(halfWidth, -halfHeight, -boxDepthInUnits);   // 5: bottom-right
    vertices.push(halfWidth, halfHeight, -boxDepthInUnits);    // 6: top-right
    vertices.push(-halfWidth, halfHeight, -boxDepthInUnits);   // 7: top-left

    // Define lines - DO NOT draw near rectangle, only depth lines and far rectangle
    // Far rectangle
    indices.push(4, 5, 5, 6, 6, 7, 7, 4);
    // Connecting edges from screen corners
    indices.push(0, 4, 1, 5, 2, 6, 3, 7);

    // Create geometry from vertices
    const boxGeometry = new THREE.BufferGeometry();
    boxGeometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    boxGeometry.setIndex(indices);

    const lineMaterial = new THREE.LineBasicMaterial({
        color: 0x00ffff,
        transparent: true,
        opacity: 0.5
    });

    const boxLines = new THREE.LineSegments(boxGeometry, lineMaterial);
    scene.add(boxLines);

    // Add orange back wall
    const backWallGeometry = new THREE.PlaneGeometry(
        BOX_WIDTH / sceneScale,
        BOX_HEIGHT / sceneScale
    );
    const backWallMaterial = new THREE.MeshBasicMaterial({
        color: 0xff8800,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.8
    });
    const backWall = new THREE.Mesh(backWallGeometry, backWallMaterial);
    backWall.position.z = -BOX_DEPTH / sceneScale;
    scene.add(backWall);

    // Add grid helper for floor reference
    const gridHelper = new THREE.GridHelper(BOX_WIDTH / sceneScale * 2, 20, 0x444444, 0x222222);
    gridHelper.rotation.x = 0;
    gridHelper.position.y = -BOX_HEIGHT / sceneScale / 2;
    gridHelper.position.z = -BOX_DEPTH / sceneScale / 2;
    scene.add(gridHelper);
}

// Auto-fit model to box dimensions
function autoFitModel() {
    if (!currentModel) return;

    // Calculate bounding box
    const box = new THREE.Box3().setFromObject(currentModel);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());

    // Create a group to handle centering
    const group = new THREE.Group();
    scene.add(group);
    group.add(currentModel);

    // Center the model at origin first
    currentModel.position.x = -center.x;
    currentModel.position.y = -center.y;
    currentModel.position.z = -center.z;

    // Convert box dimensions from cm to scene units
    const sceneScale = 10; // 1 unit = 10cm

    // Calculate scale to fit within box
    // Use 140% of box dimensions to make model bigger (was 70%)
    const targetWidth = (BOX_WIDTH / sceneScale) * 1.4;
    const targetHeight = (BOX_HEIGHT / sceneScale) * 1.4;
    const targetDepth = (BOX_DEPTH / sceneScale) * 1.4;

    const scaleX = targetWidth / size.x;
    const scaleY = targetHeight / size.y;
    const scaleZ = targetDepth / size.z;

    // Use the smallest scale to ensure model fits in all dimensions
    const optimalScale = Math.min(scaleX, scaleY, scaleZ);

    group.scale.setScalar(optimalScale);
    modelScale = optimalScale;

    // Update the scale input
    document.getElementById('modelScale').value = modelScale.toFixed(2);

    // Center model vertically in the box
    group.position.y = 0;  // Center vertically

    // Center in Z axis (middle of box depth)
    group.position.z = -BOX_DEPTH / (2 * sceneScale);

    // Update position sliders
    document.getElementById('modelZ').value = group.position.z * 10;
    document.getElementById('modelX').value = group.position.x * 10;
    document.getElementById('modelY').value = group.position.y * 10;

    // Store initial position values
    modelPositionX = group.position.x;
    modelPositionY = group.position.y;
    modelPositionZ = group.position.z;

    // Replace currentModel reference with the group
    currentModel = group;

    console.log(`Model auto-fitted: scale=${optimalScale.toFixed(3)}, size=${size.x.toFixed(1)}x${size.y.toFixed(1)}x${size.z.toFixed(1)}`);
}

// Load GLB model
function loadGLBModel(url) {
    const loader = new GLTFLoader();

    // Update status
    document.getElementById('modelStatus').textContent = `Loading: ${url}`;

    loader.load(
        url,
        (gltf) => {
            // Remove previous model if exists
            if (currentModel) {
                scene.remove(currentModel);
            }

            // Add new model
            currentModel = gltf.scene;

            // Auto-fit model to box
            autoFitModel();

            // Apply default rotation
            if (currentModel) {
                currentModel.rotation.y = modelRotationY;
            }

            // Model position is already set by autoFitModel
            modelPositionZ = currentModel.position.z * sceneScale;

            // Enable shadows
            currentModel.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                }
            });

            scene.add(currentModel);

            // Update status
            document.getElementById('modelStatus').textContent = `Loaded: ${url}`;
            console.log('GLB model loaded successfully');
        },
        (progress) => {
            const percent = (progress.loaded / progress.total * 100).toFixed(0);
            document.getElementById('modelStatus').textContent = `Loading: ${percent}%`;
        },
        (error) => {
            console.error('Error loading GLB:', error);
            document.getElementById('modelStatus').textContent = `Error loading model`;
        }
    );
}

// Set up UI controls
function setupControls() {
    // Model scale control
    document.getElementById('modelScale').addEventListener('input', (e) => {
        modelScale = parseFloat(e.target.value);
        if (currentModel) {
            currentModel.scale.setScalar(modelScale);
        }
    });

    // Model rotation control
    document.getElementById('modelRotation').addEventListener('input', (e) => {
        modelRotationY = parseFloat(e.target.value) * Math.PI / 180;
        document.getElementById('rotationValue').textContent = e.target.value + '°';
        if (currentModel) {
            currentModel.rotation.y = modelRotationY;
        }
    });

    // Model position controls
    document.getElementById('modelX').addEventListener('input', (e) => {
        modelPositionX = parseFloat(e.target.value) / 10;
        if (currentModel) {
            currentModel.position.x = modelPositionX;
        }
    });

    document.getElementById('modelY').addEventListener('input', (e) => {
        modelPositionY = parseFloat(e.target.value) / 10;
        if (currentModel) {
            currentModel.position.y = modelPositionY;
        }
    });

    document.getElementById('modelZ').addEventListener('input', (e) => {
        modelPositionZ = parseFloat(e.target.value) / 10;
        if (currentModel) {
            currentModel.position.z = modelPositionZ;
        }
    });

    // File input for custom models
    document.getElementById('modelFile').addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const url = URL.createObjectURL(file);
            loadGLBModel(url);
        }
    });

    // Lighting controls
    document.getElementById('ambientLight').addEventListener('input', (e) => {
        ambientLight.intensity = parseFloat(e.target.value);
    });

    document.getElementById('directionalLight').addEventListener('input', (e) => {
        directionalLight.intensity = parseFloat(e.target.value);
    });

    // Head tracking button
    document.getElementById('trackingBtn').addEventListener('click', toggleHeadTracking);
}

// Update camera based on head position
function updateCameraFromHeadPosition() {
    // CRITICAL: The screen IS the box opening at z=0
    // We need an off-axis frustum that ALWAYS shows the full screen at the near plane

    const near = 0.1;
    const far = 50.0;

    // Convert head position from cm to Three.js units (roughly 1 unit = 10cm)
    const sceneScale = 10; // 1 Three.js unit = 10cm

    // Head position in scene units with reduced sensitivity for gentler effect
    const sensitivityMultiplier = 0.5; // Reduced for gentler perspective changes
    const headX = (headPosition.x / sceneScale) * sensitivityMultiplier;
    const headY = (headPosition.y / sceneScale) * sensitivityMultiplier;
    const headZ = headPosition.z / sceneScale; // Keep Z at normal scale

    // Screen dimensions in scene units
    const screenWidth = BOX_WIDTH / sceneScale;
    const screenHeight = BOX_HEIGHT / sceneScale;
    const halfWidth = screenWidth / 2;
    const halfHeight = screenHeight / 2;

    // Calculate off-axis frustum bounds
    // The frustum must frame the screen exactly at the screen plane
    const left = near * (-halfWidth - headX) / headZ;
    const right = near * (halfWidth - headX) / headZ;
    const bottom = near * (-halfHeight - headY) / headZ;
    const top = near * (halfHeight - headY) / headZ;

    // Create off-axis projection matrix
    const projectionMatrix = new THREE.Matrix4();
    projectionMatrix.makePerspective(left, right, top, bottom, near, far);
    camera.projectionMatrix.copy(projectionMatrix);
    camera.projectionMatrixInverse.copy(projectionMatrix).invert();

    // Position the camera at the viewer's eye position
    camera.position.set(headX, headY, headZ);
}

// Initialize face detection
function initializeFaceDetection() {
    faceDetection = new FaceDetection({
        locateFile: (file) => {
            return `https://cdn.jsdelivr.net/npm/@mediapipe/face_detection/${file}`;
        }
    });

    faceDetection.setOptions({
        model: 'short',
        minDetectionConfidence: 0.5,
    });

    faceDetection.onResults(onFaceResults);

    video = document.getElementById('video');
    cameraUtils = new Camera(video, {
        onFrame: async () => {
            if (isHeadTracking) {
                await faceDetection.send({image: video});
            }
        },
        width: 640,
        height: 480
    });
}

// Handle face detection results
function onFaceResults(results) {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    if (results.detections && results.detections.length > 0) {
        const detection = results.detections[0];
        const bbox = detection.boundingBox;

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

        // Store last valid position
        lastValidHeadPosition.x = headPosition.x;
        lastValidHeadPosition.y = headPosition.y;
        lastValidHeadPosition.z = headPosition.z;
        hasTrackedAtLeastOnce = true;
    } else {
        document.getElementById('faceDetected').textContent = 'No (using last position)';

        // Use last valid position
        if (hasTrackedAtLeastOnce) {
            headPosition.x = lastValidHeadPosition.x;
            headPosition.y = lastValidHeadPosition.y;
            headPosition.z = lastValidHeadPosition.z;
        }
    }
}

// Update head position from face detection
function updateHeadPosition(faceX, faceY, faceWidth, faceHeight) {
    const videoWidth = overlayCanvas.width;
    const videoHeight = overlayCanvas.height;

    // Auto-calibrate on first detection
    if (!baselineFaceWidth) {
        baselineFaceWidth = faceWidth;
        console.log('Auto-calibrated baseline face width:', baselineFaceWidth);
    }

    // Calculate position
    const newDistance = (baselineFaceWidth / faceWidth) * calibratedDistance;
    const horizontalPixelOffset = faceX - (videoWidth / 2);
    const verticalPixelOffset = faceY - (videoHeight / 2);

    // Convert to cm with inverted axes for mirror effect
    const rawX = -(horizontalPixelOffset / videoWidth) * SCREEN_WIDTH_CM + CAMERA_OFFSET_X;
    const rawY = -(verticalPixelOffset / videoHeight) * SCREEN_HEIGHT_CM + CAMERA_OFFSET_Y;

    // Add to position history with timestamp
    const now = Date.now();
    positionHistory.push({
        x: rawX,
        y: rawY,
        z: newDistance,
        timestamp: now
    });

    // Remove old entries outside the smoothing window
    const cutoffTime = now - SMOOTHING_WINDOW_MS;
    while (positionHistory.length > 0 && positionHistory[0].timestamp < cutoffTime) {
        positionHistory.shift();
    }

    // Calculate average position from history
    if (positionHistory.length > 0) {
        let sumX = 0, sumY = 0, sumZ = 0;
        for (const pos of positionHistory) {
            sumX += pos.x;
            sumY += pos.y;
            sumZ += pos.z;
        }
        headPosition.x = sumX / positionHistory.length;
        headPosition.y = sumY / positionHistory.length;
        headPosition.z = sumZ / positionHistory.length;
    } else {
        // Fallback to raw values if no history
        headPosition.x = rawX;
        headPosition.y = rawY;
        headPosition.z = newDistance;
    }

    // Update display
    document.getElementById('headX').textContent = headPosition.x.toFixed(1);
    document.getElementById('headY').textContent = headPosition.y.toFixed(1);
    document.getElementById('headZ').textContent = headPosition.z.toFixed(1);
}

// Toggle head tracking
async function toggleHeadTracking() {
    if (!isHeadTracking) {
        try {
            // Check if getUserMedia is available (requires HTTPS on mobile)
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                throw new Error('Camera access not available. On mobile, HTTPS is required.');
            }

            overlayCanvas.width = 640;
            overlayCanvas.height = 480;

            await cameraUtils.start();

            isHeadTracking = true;
            document.getElementById('trackingStatus').textContent = 'On';
            document.getElementById('trackingBtn').textContent = 'Stop Head Tracking';
        } catch (err) {
            console.error('Failed to start camera:', err);
            document.getElementById('trackingStatus').textContent = 'Error';
            alert('Camera access failed: ' + err.message);
        }
    } else {
        isHeadTracking = false;
        document.getElementById('trackingStatus').textContent = 'Off';
        document.getElementById('trackingBtn').textContent = 'Start Head Tracking';
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    }
}

// Render interlaced stereo
function renderInterlacedStereo() {
    const canvas = renderer.domElement;
    const width = canvas.width;
    const height = canvas.height;

    // Eye separation in cm (typical IPD is 6.5cm)
    const eyeSeparation = 6.5;
    const halfSeparation = eyeSeparation / 20; // Convert to scene units

    // Store original camera position
    const originalX = camera.position.x;

    // Render left eye (even lines)
    camera.position.x = originalX - halfSeparation;
    camera.updateProjectionMatrix();
    renderer.setScissorTest(true);

    for (let y = 0; y < height; y += 2) {
        renderer.setScissor(0, y, width, 1);
        renderer.setViewport(0, 0, width, height);
        renderer.render(scene, camera);
    }

    // Render right eye (odd lines)
    camera.position.x = originalX + halfSeparation;
    camera.updateProjectionMatrix();

    for (let y = 1; y < height; y += 2) {
        renderer.setScissor(0, y, width, 1);
        renderer.setViewport(0, 0, width, height);
        renderer.render(scene, camera);
    }

    // Restore camera position
    camera.position.x = originalX;
    camera.updateProjectionMatrix();
    renderer.setScissorTest(false);
}

// Toggle interlaced stereo mode - expose globally for HTML onchange
window.toggleInterlacedMode = function() {
    const checkbox = document.getElementById('interlacedMode');
    isInterlacedMode = checkbox.checked;
    console.log('Interlaced stereo mode:', isInterlacedMode ? 'ON' : 'OFF');
}

// Calibrate distance - expose globally for HTML onclick
window.calibrateDistance = function() {
    if (isHeadTracking && document.getElementById('faceDetected').textContent === 'Yes') {
        const userDistance = prompt('How far are you from the screen in cm?', '40');
        if (userDistance && !isNaN(userDistance)) {
            calibratedDistance = parseFloat(userDistance);
            headPosition.z = calibratedDistance;
            alert(`Distance calibrated to ${userDistance}cm`);
        }
    } else {
        alert('Please start head tracking and ensure your face is detected first');
    }
}

// Setup mobile UI functionality
function setupMobileUI() {
    const controls = document.getElementById('controls');
    const isometricDebug = document.getElementById('isometric-debug');
    // Collapse on mobile or landscape with limited height
    const isMobile = window.matchMedia('(max-width: 768px)').matches ||
                     window.matchMedia('(max-height: 500px)').matches;

    if (isMobile) {
        // Start minimized on mobile
        controls.classList.add('minimized');

        // Hide isometric debug view on mobile by default
        isometricDebug.style.display = 'none';

        // Add click handler to h3 to toggle
        const h3 = controls.querySelector('h3');
        h3.addEventListener('click', () => {
            controls.classList.toggle('minimized');

            // Show/hide isometric debug when controls are expanded/collapsed
            if (controls.classList.contains('minimized')) {
                isometricDebug.style.display = 'none';
            } else {
                isometricDebug.style.display = 'block';
            }
        });

        // Prevent clicks inside control groups from toggling
        const controlGroups = controls.querySelectorAll('.control-group');
        controlGroups.forEach(group => {
            group.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        });
    }
}

// Draw isometric debug view
function drawIsometricDebugView() {
    const canvas = document.getElementById('isometric-debug');
    const ctx = canvas.getContext('2d');

    // Clear canvas
    ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw simple overhead view
    const centerX = canvas.width / 2;
    const centerY = canvas.height / 2;
    const scale = 2;

    // Draw box
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.strokeRect(
        centerX - BOX_WIDTH * scale / 2,
        centerY - BOX_DEPTH * scale / 2,
        BOX_WIDTH * scale,
        BOX_DEPTH * scale
    );

    // Draw viewer position
    const viewerX = centerX + (headPosition.x / 10) * scale;
    const viewerY = centerY + (headPosition.z - 40) * scale;

    ctx.fillStyle = '#ff0000';
    ctx.beginPath();
    ctx.arc(viewerX, viewerY, 5, 0, Math.PI * 2);
    ctx.fill();

    // Draw model position if exists
    if (currentModel) {
        const modelX = centerX + modelPositionX * scale;
        const modelY = centerY - modelPositionZ * scale;

        ctx.fillStyle = '#00ff00';
        ctx.beginPath();
        ctx.arc(modelX, modelY, 8, 0, Math.PI * 2);
        ctx.fill();
    }

    // Labels
    ctx.fillStyle = '#00ff00';
    ctx.font = '10px monospace';
    ctx.fillText('Top View', 10, 20);
    ctx.fillText(`Viewer Z: ${headPosition.z.toFixed(0)}cm`, 10, 35);
}

// Animation loop
function animate() {
    requestAnimationFrame(animate);

    // Update camera from head position
    updateCameraFromHeadPosition();

    // Rotate model if needed
    if (currentModel && document.getElementById('modelRotation')) {
        // Model rotation is now controlled by slider
    }

    // Update directional light to follow viewer
    directionalLight.position.set(
        headPosition.x / 10,
        headPosition.y / 10 + 10,
        headPosition.z
    );

    // Render scene (with interlaced stereo if enabled)
    if (isInterlacedMode) {
        renderInterlacedStereo();
    } else {
        renderer.render(scene, camera);
    }

    // Draw debug view
    drawIsometricDebugView();
}

// Handle window resize
window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// Initialize everything on load
window.addEventListener('load', async () => {
    // Get DOM elements
    overlayCanvas = document.getElementById('canvas-overlay');
    overlayCtx = overlayCanvas.getContext('2d');

    // Initialize Three.js
    initThreeJS();

    // Initialize face detection
    initializeFaceDetection();

    // Start animation loop
    animate();

    console.log('GLB demo initialized');

    // Setup mobile UI
    setupMobileUI();

    // Auto-start head tracking after a short delay (only if getUserMedia is available)
    setTimeout(async () => {
        // Check if getUserMedia is available before auto-starting
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            console.log('Camera access not available - skipping auto-start of head tracking');
            document.getElementById('trackingStatus').textContent = 'Unavailable';
            return;
        }

        console.log('Auto-starting head tracking...');

        try {
            // Start head tracking
            await toggleHeadTracking();

            // Sometimes MediaPipe needs a second attempt to fully initialize
            setTimeout(async () => {
                if (!isHeadTracking) {
                    console.log('Retrying head tracking...');
                    await toggleHeadTracking();
                }
            }, 1000);
        } catch (err) {
            console.error('Failed to auto-start head tracking:', err);
        }
    }, 500);
});
