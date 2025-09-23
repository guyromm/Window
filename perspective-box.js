 // WebGL and 3D scene variables
let gl;
let program;
let litProgram; // New lit shader program for textured models
let positionLocation;
let mvpLocation;
let interlacedLocation;
let eyePassLocation;
let lineColorLocation;

// Lit shader locations
let litPositionLocation;
let litNormalLocation;
let litMvpLocation;
let litNormalMatrixLocation;
let litLightPosLocation;
let litColorLocation;
let litViewPosLocation;

let isInterlacedMode = false;

// Textures
let floorTexture;
let ceilingTexture;
let wallTexture;
let lampTexture;
let purpleTexture;
let greenTexture;

// Stereoscopic settings
const EYE_SEPARATION = 6.5; // Average human IPD in cm

// Head tracking variables
let faceDetection;
let camera;
let isHeadTracking = false;
let baselineFaceWidth = null;
let calibratedDistance = 40; // Default 40cm viewing distance (laptop)

// Deterministic random number generator (seeded)
function seededRandom(seed) {
    let x = Math.sin(seed) * 10000;
    return x - Math.floor(x);
}

// STL file parser (binary format)
function parseSTL(arrayBuffer) {
    const dataView = new DataView(arrayBuffer);
    const vertices = [];
    const normals = [];

    // Skip 80-byte header
    let offset = 80;

    // Read number of triangles (4 bytes)
    const numTriangles = dataView.getUint32(offset, true);
    offset += 4;

    console.log(`Loading STL with ${numTriangles} triangles`);

    // Read each triangle
    for (let i = 0; i < numTriangles; i++) {
        // Read normal vector (3 floats)
        const nx = dataView.getFloat32(offset, true);
        const ny = dataView.getFloat32(offset + 4, true);
        const nz = dataView.getFloat32(offset + 8, true);
        offset += 12;

        // Read 3 vertices (3 floats each)
        for (let j = 0; j < 3; j++) {
            const vx = dataView.getFloat32(offset, true);
            const vy = dataView.getFloat32(offset + 4, true);
            const vz = dataView.getFloat32(offset + 8, true);
            offset += 12;

            vertices.push(vx, vy, vz);
            normals.push(nx, ny, nz);
        }

        // Skip attribute byte count (2 bytes)
        offset += 2;
    }

    return { vertices, normals, numTriangles };
}

// Load STL file
async function loadSTL() {
    try {
        const response = await fetch('lighthousescene.stl');
        const arrayBuffer = await response.arrayBuffer();
        const stlData = parseSTL(arrayBuffer);

        // Convert to Float32Arrays
        stlVertices = new Float32Array(stlData.vertices);
        stlNormals = new Float32Array(stlData.normals);
        stlNumTriangles = stlData.numTriangles;

        // Calculate bounding box to scale and center the model
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (let i = 0; i < stlVertices.length; i += 3) {
            minX = Math.min(minX, stlVertices[i]);
            maxX = Math.max(maxX, stlVertices[i]);
            minY = Math.min(minY, stlVertices[i + 1]);
            maxY = Math.max(maxY, stlVertices[i + 1]);
            minZ = Math.min(minZ, stlVertices[i + 2]);
            maxZ = Math.max(maxZ, stlVertices[i + 2]);
        }

        const sizeX = maxX - minX;
        const sizeY = maxY - minY;
        const sizeZ = maxZ - minZ;
        const centerX = (maxX + minX) / 2;
        const centerY = (maxY + minY) / 2;
        const centerZ = (maxZ + minZ) / 2;

        console.log(`STL bounds: X[${minX}, ${maxX}], Y[${minY}, ${maxY}], Z[${minZ}, ${maxZ}]`);
        console.log(`STL size: ${sizeX} x ${sizeY} x ${sizeZ}`);

        // Scale to fit within box (use 80% of box dimensions)
        const targetSizeX = CORRIDOR_WIDTH * 0.8;
        const targetSizeY = CORRIDOR_HEIGHT * 0.8;
        const targetSizeZ = Math.abs(CORRIDOR_FAR - CORRIDOR_NEAR) * 0.8;

        const scaleX = targetSizeX / sizeX;
        const scaleY = targetSizeY / sizeY;
        const scaleZ = targetSizeZ / sizeZ;
        const scale = Math.min(scaleX, scaleY, scaleZ);

        // Transform vertices to fit in box
        for (let i = 0; i < stlVertices.length; i += 3) {
            // Center at origin
            const x = stlVertices[i] - centerX;
            const y = stlVertices[i + 1] - centerY;
            const z = stlVertices[i + 2] - centerZ;

            // Scale
            const scaledX = x * scale;
            const scaledY = y * scale;
            const scaledZ = z * scale;

            // Rotate 90 degrees around X axis (to stand upright)
            // But flip it right-side up (rotate opposite direction)
            // newY = Z, newZ = -Y
            stlVertices[i] = scaledX;
            stlVertices[i + 1] = scaledZ;
            stlVertices[i + 2] = -scaledY;

        }

        // Find the minimum Y value after rotation to align with floor
        let minYAfterRotation = Infinity;
        for (let i = 1; i < stlVertices.length; i += 3) {
            minYAfterRotation = Math.min(minYAfterRotation, stlVertices[i]);
        }

        // Adjust all vertices to place model on floor
        const floorY = -CORRIDOR_HEIGHT / 2;
        const yOffset = floorY - minYAfterRotation;

        for (let i = 0; i < stlVertices.length; i += 3) {
            // Position in box (centered horizontally, on floor, mid-depth)
            stlVertices[i + 2] += (CORRIDOR_NEAR + CORRIDOR_FAR) / 2;
            stlVertices[i + 1] += yOffset; // Align bottom to floor
        }

        // Create WebGL buffers
        if (gl) {
            stlVertexBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, stlVertexBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, stlVertices, gl.STATIC_DRAW);

            console.log(`STL loaded and scaled by ${scale.toFixed(3)}`);
        }

    } catch (error) {
        console.error('Failed to load STL:', error);
    }
}

// Load Cat STL file
async function loadCatSTL() {
    try {
        const response = await fetch('LPcatBP.stl');
        const arrayBuffer = await response.arrayBuffer();
        const stlData = parseSTL(arrayBuffer);

        // Convert to Float32Arrays
        catVertices = new Float32Array(stlData.vertices);
        catNormals = new Float32Array(stlData.normals);
        catNumTriangles = stlData.numTriangles;

        // Calculate bounding box to scale and center the model
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        for (let i = 0; i < catVertices.length; i += 3) {
            minX = Math.min(minX, catVertices[i]);
            maxX = Math.max(maxX, catVertices[i]);
            minY = Math.min(minY, catVertices[i + 1]);
            maxY = Math.max(maxY, catVertices[i + 1]);
            minZ = Math.min(minZ, catVertices[i + 2]);
            maxZ = Math.max(maxZ, catVertices[i + 2]);
        }

        const sizeX = maxX - minX;
        const sizeY = maxY - minY;
        const sizeZ = maxZ - minZ;
        const centerX = (maxX + minX) / 2;
        const centerY = (maxY + minY) / 2;
        const centerZ = (maxZ + minZ) / 2;

        console.log(`Cat STL bounds: X[${minX}, ${maxX}], Y[${minY}, ${maxY}], Z[${minZ}, ${maxZ}]`);
        console.log(`Cat STL size: ${sizeX} x ${sizeY} x ${sizeZ}`);

        // Scale to fit within box (use smaller scale for cat - 40% of box dimensions)
        const targetSizeX = CORRIDOR_WIDTH * 0.4;
        const targetSizeY = CORRIDOR_HEIGHT * 0.4;
        const targetSizeZ = Math.abs(CORRIDOR_FAR - CORRIDOR_NEAR) * 0.3;

        const scaleX = targetSizeX / sizeX;
        const scaleY = targetSizeY / sizeY;
        const scaleZ = targetSizeZ / sizeZ;
        const scale = Math.min(scaleX, scaleY, scaleZ);

        // Transform vertices and normals to fit in box
        for (let i = 0; i < catVertices.length; i += 3) {
            // Transform vertex
            const x = catVertices[i] - centerX;
            const y = catVertices[i + 1] - centerY;
            const z = catVertices[i + 2] - centerZ;

            // Scale
            const scaledX = x * scale;
            const scaledY = y * scale;
            const scaledZ = z * scale;

            // Rotate 90 degrees around X axis (to stand upright)
            // But flip it right-side up (rotate opposite direction)
            // newY = Z, newZ = -Y
            catVertices[i] = scaledX;
            catVertices[i + 1] = scaledZ;
            catVertices[i + 2] = -scaledY;

            // Transform normal (rotation only, no scaling or translation)
            const nx = catNormals[i];
            const ny = catNormals[i + 1];
            const nz = catNormals[i + 2];

            // Apply same rotation to normals
            catNormals[i] = nx;
            catNormals[i + 1] = nz;
            catNormals[i + 2] = -ny;
        }

        // Find the minimum Y value after rotation to align with floor
        let minYAfterRotation = Infinity;
        for (let i = 1; i < catVertices.length; i += 3) {
            minYAfterRotation = Math.min(minYAfterRotation, catVertices[i]);
        }

        // Adjust all vertices to place model on floor
        const floorY = -CORRIDOR_HEIGHT / 2;
        const yOffset = floorY - minYAfterRotation;

        for (let i = 0; i < catVertices.length; i += 3) {
            // Position in box (centered horizontally, on floor, MUCH closer to viewer)
            catVertices[i + 2] += -8; // Much closer to viewer (just 8cm behind screen)
            catVertices[i + 1] += yOffset; // Align bottom to floor
            catVertices[i] -= 3; // Slight offset to the left to not block view
        }

        // Create WebGL buffers
        if (gl) {
            catVertexBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, catVertexBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, catVertices, gl.STATIC_DRAW);

            catNormalBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, catNormalBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, catNormals, gl.STATIC_DRAW);

            console.log(`Cat STL loaded and scaled by ${scale.toFixed(3)}`);
        }

    } catch (error) {
        console.error('Failed to load cat STL:', error);
    }
}

// Generate 100 deterministic random spots (will be initialized after constants)
const NUM_SPOTS = 100;
let spots = [];

// STL model data - lighthouse
let stlVertices = null;
let stlNormals = null;
let stlVertexBuffer = null;
let stlIndexBuffer = null;
let stlNumTriangles = 0;

// STL model data - LPcatBP (cat)
let catVertices = null;
let catNormals = null;
let catVertexBuffer = null;
let catNormalBuffer = null;
let catNumTriangles = 0;

// Head position (in cm, relative to screen center)
// Will be initialized after constants are defined
let headPosition = { x: 0, y: 0, z: 40 }; // Default 40cm viewing distance
let lastValidHeadPosition = { x: 0, y: 0, z: 40 }; // Store last valid position
let hasTrackedAtLeastOnce = false; // Flag to know if we've ever had successful tracking

// Smoothing variables for jitter reduction
const positionHistory = [];
const SMOOTHING_WINDOW_MS = 200; // 1/5 second averaging window
let lastPositionUpdateTime = Date.now();

let video;
let overlayCanvas;
let overlayCtx;

// Screen dimensions for 14" laptop screen (16:9 aspect ratio)
// 14" diagonal = 35.6 cm diagonal
// Width ≈ 30.9 cm, Height ≈ 17.4 cm
const SCREEN_WIDTH_CM = 30.9;
const SCREEN_HEIGHT_CM = 17.4;

// Camera offset from screen center (in cm)
// Camera is at the center-top of the display
// x = 0 (centered horizontally)
// y = 8.7cm (half of 17.4cm height - at the top edge)
const CAMERA_OFFSET_X = 0;  // Camera is centered horizontally
const CAMERA_OFFSET_Y = 8.7;  // Camera is at the top of screen (17.4/2)

// Corridor geometry (global, to keep the viewer "inside" the corridor)
// Box dimensions match the screen size (14" diagonal)
const CORRIDOR_WIDTH = SCREEN_WIDTH_CM;   // 30.9cm - same as screen width
const CORRIDOR_HEIGHT = SCREEN_HEIGHT_CM; // 17.4cm - same as screen height
const CORRIDOR_NEAR = 0;     // Screen plane IS the near wall - no offset!
const CORRIDOR_FAR = -30;    // 30cm deep box (similar to width for good proportions)

// Create procedural textures
function createProceduralTextures() {
    // Create checkered floor texture
    function createCheckerTexture() {
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        const tileSize = 64; // Doubled tile size
        for (let y = 0; y < size; y += tileSize) {
            for (let x = 0; x < size; x += tileSize) {
                const isEven = ((x / tileSize) + (y / tileSize)) % 2 === 0;
                ctx.fillStyle = isEven ? '#ffffff' : '#333333';
                ctx.fillRect(x, y, tileSize, tileSize);
            }
        }

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        return texture;
    }

    // Create brick wall texture
    function createBrickTexture() {
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        // Base brick color
        ctx.fillStyle = '#8B4513';
        ctx.fillRect(0, 0, size, size);

        // Draw brick pattern
        const brickWidth = 64;
        const brickHeight = 24;
        const mortarWidth = 4;

        ctx.strokeStyle = '#444444';
        ctx.lineWidth = mortarWidth;

        for (let y = 0; y < size; y += brickHeight) {
            const offset = (y / brickHeight) % 2 === 0 ? 0 : brickWidth / 2;
            for (let x = -brickWidth; x < size + brickWidth; x += brickWidth) {
                ctx.strokeRect(x + offset, y, brickWidth, brickHeight);
            }
        }

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        return texture;
    }

    // Create wood plank ceiling texture
    function createWoodTexture() {
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        // Base wood color
        ctx.fillStyle = '#654321';
        ctx.fillRect(0, 0, size, size);

        // Draw wood grain
        ctx.strokeStyle = '#4a3018';
        ctx.lineWidth = 1;
        for (let y = 0; y < size; y += 3) {
            ctx.beginPath();
            ctx.moveTo(0, y + Math.sin(y * 0.1) * 2);
            ctx.lineTo(size, y + Math.sin(y * 0.1) * 2);
            ctx.stroke();
        }

        // Draw plank divisions
        ctx.strokeStyle = '#333333';
        ctx.lineWidth = 2;
        for (let x = 0; x < size; x += 64) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, size);
            ctx.stroke();
        }

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        return texture;
    }

    // Create metallic yellow lamp texture
    function createLampTexture() {
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        // Create metallic gradient for lamp shade
        const gradient = ctx.createRadialGradient(size/2, size/2, 0, size/2, size/2, size/2);
        gradient.addColorStop(0, '#FFEB3B');    // Bright yellow center
        gradient.addColorStop(0.5, '#FFC107');  // Darker yellow
        gradient.addColorStop(1, '#FF8F00');    // Orange edges

        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);

        // Add some metallic shine highlights
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 2;
        for (let i = 0; i < 10; i++) {
            const x = Math.random() * size;
            const y = Math.random() * size;
            ctx.beginPath();
            ctx.arc(x, y, Math.random() * 10 + 5, 0, Math.PI * 2);
            ctx.stroke();
        }

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        return texture;
    }

    // Create solid green texture for table (was purple)
    function createPurpleTexture() {  // Keeping function name for compatibility
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        // Solid green with slight gradient for depth
        const gradient = ctx.createLinearGradient(0, 0, size, size);
        gradient.addColorStop(0, '#4CAF50');    // Material green
        gradient.addColorStop(0.5, '#388E3C');  // Darker green
        gradient.addColorStop(1, '#2E7D32');    // Even darker

        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        return texture;
    }

    // Create solid orange texture for chair (was green)
    function createGreenTexture() {  // Keeping function name for compatibility
        const size = 256;
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');

        // Solid orange with slight gradient
        const gradient = ctx.createLinearGradient(0, 0, size, size);
        gradient.addColorStop(0, '#FF9800');    // Material orange
        gradient.addColorStop(0.5, '#F57C00');  // Darker orange
        gradient.addColorStop(1, '#E65100');    // Even darker

        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, size, size);

        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        return texture;
    }

    floorTexture = createCheckerTexture();
    ceilingTexture = createWoodTexture();
    wallTexture = createBrickTexture();
    lampTexture = createLampTexture();
    purpleTexture = createPurpleTexture();
    greenTexture = createGreenTexture();
}

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
        uniform mat4 mvpMatrix;

        void main() {
            gl_Position = mvpMatrix * vec4(position, 1.0);
        }
    `;

    // Fragment shader with interlaced stereo support for wireframe lines
    const fragmentShaderSource = `
        precision mediump float;
        uniform bool interlaced;
        uniform int eyePass; // 0 for left eye, 1 for right eye
        uniform vec3 lineColor;

        void main() {
            vec3 finalColor = lineColor;

            if (interlaced) {
                float row = floor(gl_FragCoord.y);
                bool isEvenRow = mod(row, 2.0) < 0.5;

                if (eyePass == 1 && isEvenRow) {
                    gl_FragColor = vec4(finalColor.r, 0.0, 0.0, 1.0);
                } else if (eyePass == 0 && !isEvenRow) {
                    gl_FragColor = vec4(0.0, 0.0, finalColor.b, 1.0);
                } else {
                    discard;
                }
            } else {
                gl_FragColor = vec4(finalColor, 1.0);
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
    mvpLocation = gl.getUniformLocation(program, 'mvpMatrix');
    interlacedLocation = gl.getUniformLocation(program, 'interlaced');
    eyePassLocation = gl.getUniformLocation(program, 'eyePass');
    lineColorLocation = gl.getUniformLocation(program, 'lineColor');

    gl.enableVertexAttribArray(positionLocation);

    // Set default line color (white)
    gl.uniform3f(lineColorLocation, 1.0, 1.0, 1.0);

    // Create lit shader program for solid models with lighting
    const litVertexShaderSource = `
        attribute vec3 position;
        attribute vec3 normal;
        uniform mat4 mvpMatrix;
        uniform mat3 normalMatrix;

        varying vec3 vNormal;
        varying vec3 vPosition;

        void main() {
            gl_Position = mvpMatrix * vec4(position, 1.0);
            vNormal = normalize(normalMatrix * normal);
            vPosition = position;
        }
    `;

    const litFragmentShaderSource = `
        precision mediump float;

        uniform vec3 lightPos;     // Light position (viewer position)
        uniform vec3 viewPos;       // Camera/viewer position
        uniform vec3 objectColor;   // Base color of the object

        varying vec3 vNormal;
        varying vec3 vPosition;

        void main() {
            // Ambient lighting
            float ambientStrength = 0.3;
            vec3 ambient = ambientStrength * objectColor;

            // Diffuse lighting
            vec3 lightDir = normalize(lightPos - vPosition);
            float diff = max(dot(vNormal, lightDir), 0.0);
            vec3 diffuse = diff * objectColor;

            // Specular lighting
            float specularStrength = 0.5;
            vec3 viewDir = normalize(viewPos - vPosition);
            vec3 reflectDir = reflect(-lightDir, vNormal);
            float spec = pow(max(dot(viewDir, reflectDir), 0.0), 32.0);
            vec3 specular = specularStrength * spec * vec3(1.0, 1.0, 1.0);

            // Combine lighting components
            vec3 result = ambient + diffuse + specular;

            // Add some distance fog for depth
            float distance = length(viewPos - vPosition);
            float fogFactor = 1.0 - clamp(distance / 50.0, 0.0, 0.3);
            result = mix(vec3(0.1, 0.1, 0.2), result, fogFactor);

            gl_FragColor = vec4(result, 1.0);
        }
    `;

    // Create and compile lit shaders
    const litVertexShader = createShader(gl, gl.VERTEX_SHADER, litVertexShaderSource);
    const litFragmentShader = createShader(gl, gl.FRAGMENT_SHADER, litFragmentShaderSource);
    litProgram = createProgram(gl, litVertexShader, litFragmentShader);

    if (!litProgram) {
        console.error('Failed to create lit shader program');
        return false;
    }

    // Get lit shader locations
    litPositionLocation = gl.getAttribLocation(litProgram, 'position');
    litNormalLocation = gl.getAttribLocation(litProgram, 'normal');
    litMvpLocation = gl.getUniformLocation(litProgram, 'mvpMatrix');
    litNormalMatrixLocation = gl.getUniformLocation(litProgram, 'normalMatrix');
    litLightPosLocation = gl.getUniformLocation(litProgram, 'lightPos');
    litColorLocation = gl.getUniformLocation(litProgram, 'objectColor');
    litViewPosLocation = gl.getUniformLocation(litProgram, 'viewPos');

    gl.enableVertexAttribArray(litPositionLocation);
    gl.enableVertexAttribArray(litNormalLocation);

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
    // Column-major (OpenGL/WebGL) matrix multiplication: result = a * b
    const result = new Float32Array(16);
    for (let row = 0; row < 4; row++) {
        for (let col = 0; col < 4; col++) {
            result[col * 4 + row] =
                a[0 * 4 + row] * b[col * 4 + 0] +
                a[1 * 4 + row] * b[col * 4 + 1] +
                a[2 * 4 + row] * b[col * 4 + 2] +
                a[3 * 4 + row] * b[col * 4 + 3];
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
    // Create a perspective matrix that properly shows the box interior
    const near = 0.1; // Very small near plane
    const far = 200.0; // Increased far plane to prevent clipping

    // Calculate field of view based on viewer distance and screen size
    // When viewer is at 40cm, they should see the full screen/box opening
    const aspect = SCREEN_WIDTH_CM / SCREEN_HEIGHT_CM;

    // Calculate frustum bounds for proper perspective
    // At the viewer's distance, we want to see the full box opening
    const halfWidth = SCREEN_WIDTH_CM / 2;
    const halfHeight = SCREEN_HEIGHT_CM / 2;

    // CRITICAL: The screen IS the window at z=0
    // The corners of the box MUST always align with screen corners
    // This means the frustum at z=0 must EXACTLY match the screen dimensions

    // At the screen plane (z=0), we want to see exactly from -halfWidth to +halfWidth
    // and from -halfHeight to +halfHeight

    // The key insight: we need to use the ACTUAL viewer Z distance for the frustum
    // to ensure the screen plane always fills the viewport exactly
    const left = near * (-halfWidth - headX) / headZ;
    const right = near * (halfWidth - headX) / headZ;
    const bottom = near * (-halfHeight - headY) / headZ;
    const top = near * (halfHeight - headY) / headZ;

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

    // Draw isometric debug view (using corridor dimensions)
    drawIsometricDebugView(CORRIDOR_WIDTH, CORRIDOR_HEIGHT, CORRIDOR_NEAR, CORRIDOR_FAR);
}

function renderEye(eyeX, eyeY, eyeZ) {
    // Create perspective projection matrix for this eye
    const projectionMatrix = createPerspectiveCorrectedMatrix(eyeX, eyeY, eyeZ);

    // Create view matrix that positions camera at the viewer's position
    // We need to translate the world opposite to camera movement
    const viewMatrix = new Float32Array([
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        -eyeX, -eyeY, -eyeZ, 1
    ]);

    // Box dimensions (use corridor constants)
    const corridorWidth = CORRIDOR_WIDTH;
    const corridorHeight = CORRIDOR_HEIGHT;
    const corridorNear = CORRIDOR_NEAR;
    const corridorFar = CORRIDOR_FAR;

    // Define 8 corners of the box
    // Box is positioned with near face at screen (z=0) and extends into negative Z
    const vertices = [
        // Near face (at screen plane)
        -corridorWidth/2, -corridorHeight/2, corridorNear,  // 0 near-bottom-left
         corridorWidth/2, -corridorHeight/2, corridorNear,  // 1 near-bottom-right
         corridorWidth/2,  corridorHeight/2, corridorNear,  // 2 near-top-right
        -corridorWidth/2,  corridorHeight/2, corridorNear,  // 3 near-top-left
        // Far face (back wall)
        -corridorWidth/2, -corridorHeight/2, corridorFar,   // 4 far-bottom-left
         corridorWidth/2, -corridorHeight/2, corridorFar,   // 5 far-bottom-right
         corridorWidth/2,  corridorHeight/2, corridorFar,   // 6 far-top-right
        -corridorWidth/2,  corridorHeight/2, corridorFar    // 7 far-top-left
    ];

    // Indices for lines - NEVER draw near rectangle, only depth lines from corners
    const lineIndices = [
        // Far rectangle edges (back wall)
        4, 5,  5, 6,  6, 7,  7, 4,

        // Connecting edges (depth lines) - these MUST start from screen corners
        0, 4,  1, 5,  2, 6,  3, 7
    ];

    // Create and bind buffers
    const positionBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(vertices), gl.STATIC_DRAW);
    gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(lineIndices), gl.STATIC_DRAW);

    // Combine projection and view matrices
    const mvpMatrix = multiply(projectionMatrix, viewMatrix);

    // Set MVP matrix
    gl.uniformMatrix4fv(mvpLocation, false, mvpMatrix);

    // Draw wireframe box edges
    gl.drawElements(gl.LINES, lineIndices.length, gl.UNSIGNED_SHORT, 0);

    // Draw filled orange far wall
    const farWallIndices = [
        4, 5, 6,  // First triangle of far wall
        4, 6, 7   // Second triangle of far wall
    ];

    // Set orange color for the far wall
    gl.uniform3f(lineColorLocation, 1.0, 0.5, 0.0); // Orange color

    // Create buffer for far wall triangles
    const farWallIndexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, farWallIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(farWallIndices), gl.STATIC_DRAW);

    // Draw the far wall as filled triangles
    gl.drawElements(gl.TRIANGLES, farWallIndices.length, gl.UNSIGNED_SHORT, 0);

    // Reset color back to white for the wireframe
    gl.uniform3f(lineColorLocation, 1.0, 1.0, 1.0);

    // Render the spots
    renderSpots(mvpMatrix);

    // Render the STL models if loaded
    // Render cat first (it's in front)
    if (catVertexBuffer) {
        renderCatSTL(mvpMatrix);
    }
    // Then render lighthouse (it's behind)
    if (stlVertexBuffer) {
        renderSTL(mvpMatrix);
    }
}

function renderCatSTL(mvpMatrix) {
    // Switch to lit shader program
    gl.useProgram(litProgram);

    // Bind vertex buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, catVertexBuffer);
    gl.vertexAttribPointer(litPositionLocation, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(litPositionLocation);

    // Bind normal buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, catNormalBuffer);
    gl.vertexAttribPointer(litNormalLocation, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(litNormalLocation);

    // Set MVP matrix
    gl.uniformMatrix4fv(litMvpLocation, false, mvpMatrix);

    // Calculate normal matrix (inverse transpose of model-view matrix)
    // For simplicity, using identity since we're not doing complex transformations
    const normalMatrix = new Float32Array([
        1, 0, 0,
        0, 1, 0,
        0, 0, 1
    ]);
    gl.uniformMatrix3fv(litNormalMatrixLocation, false, normalMatrix);

    // Set light position (viewer position)
    gl.uniform3f(litLightPosLocation, headPosition.x, headPosition.y, headPosition.z);

    // Set view position (same as light for headlight effect)
    gl.uniform3f(litViewPosLocation, headPosition.x, headPosition.y, headPosition.z);

    // Set object color (warm orange-brown for cat)
    gl.uniform3f(litColorLocation, 0.8, 0.5, 0.3);

    // Enable depth testing for solid rendering
    gl.enable(gl.DEPTH_TEST);

    // Draw as solid triangles
    gl.drawArrays(gl.TRIANGLES, 0, catNumTriangles * 3);

    // Switch back to wireframe shader
    gl.useProgram(program);
}

function renderSTL(mvpMatrix) {
    // Bind the STL vertex buffer
    gl.bindBuffer(gl.ARRAY_BUFFER, stlVertexBuffer);
    gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);

    // Set MVP matrix
    gl.uniformMatrix4fv(mvpLocation, false, mvpMatrix);

    // Set line width (WebGL typically only supports 1.0, but we can try)
    gl.lineWidth(1.0);

    // Set a nice color for the STL model (cyan for visibility)
    gl.uniform3f(lineColorLocation, 0.0, 0.8, 0.8);

    // Draw as wireframe - skip some triangles to reduce density
    // Draw every 5th triangle to make wireframe less dense
    const skipFactor = 5;
    for (let i = 0; i < stlNumTriangles; i += skipFactor) {
        const offset = i * 3;
        // Draw triangle edges using LINE_LOOP (connects vertices and closes the loop)
        gl.drawArrays(gl.LINE_LOOP, offset, 3);
    }

    // Reset color
    gl.uniform3f(lineColorLocation, 1.0, 1.0, 1.0);
}

function renderSpots(mvpMatrix) {
    // Create vertices for all spots (rendered as small crosses or points)
    const spotVertices = [];
    const spotColors = [];
    const spotIndices = [];

    const spotSize = 0.3; // Size of each spot in cm

    spots.forEach((spot, index) => {
        const baseIndex = index * 6; // 6 vertices per spot (for a small octahedron)

        // Create a small octahedron for each spot
        spotVertices.push(
            spot.x + spotSize, spot.y, spot.z,  // right
            spot.x - spotSize, spot.y, spot.z,  // left
            spot.x, spot.y + spotSize, spot.z,  // top
            spot.x, spot.y - spotSize, spot.z,  // bottom
            spot.x, spot.y, spot.z + spotSize,  // front
            spot.x, spot.y, spot.z - spotSize   // back
        );

        // Add color for each vertex
        for (let i = 0; i < 6; i++) {
            spotColors.push(spot.r, spot.g, spot.b);
        }

        // Create triangles for the octahedron
        spotIndices.push(
            // Top pyramid
            baseIndex + 2, baseIndex + 0, baseIndex + 4,
            baseIndex + 2, baseIndex + 4, baseIndex + 1,
            baseIndex + 2, baseIndex + 1, baseIndex + 5,
            baseIndex + 2, baseIndex + 5, baseIndex + 0,
            // Bottom pyramid
            baseIndex + 3, baseIndex + 4, baseIndex + 0,
            baseIndex + 3, baseIndex + 1, baseIndex + 4,
            baseIndex + 3, baseIndex + 5, baseIndex + 1,
            baseIndex + 3, baseIndex + 0, baseIndex + 5
        );
    });

    // Create and bind buffers for spots
    const spotPositionBuffer = gl.createBuffer();
    const spotIndexBuffer = gl.createBuffer();

    gl.bindBuffer(gl.ARRAY_BUFFER, spotPositionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(spotVertices), gl.STATIC_DRAW);
    gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, spotIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(spotIndices), gl.STATIC_DRAW);

    // Set MVP matrix
    gl.uniformMatrix4fv(mvpLocation, false, mvpMatrix);

    // Draw each spot with its color
    spots.forEach((spot, index) => {
        gl.uniform3f(lineColorLocation, spot.r, spot.g, spot.b);
        const startIndex = index * 24; // 8 triangles * 3 vertices each
        gl.drawElements(gl.TRIANGLES, 24, gl.UNSIGNED_SHORT, startIndex * 2);
    });

    // Reset color
    gl.uniform3f(lineColorLocation, 1.0, 1.0, 1.0);
}

// Function to render objects in the corridor
function renderCorridorObjects(mvpMatrix) {
    // Helpers to align objects with floor/ceiling based on corridor geometry
    function floorYAtZ(z) {
        // Flat shoebox floor
        return -CORRIDOR_HEIGHT / 2;
    }
    function ceilingYAtZ(z) {
        // Flat shoebox ceiling
        return CORRIDOR_HEIGHT / 2;
    }

    // Object 1: Table (center, very close to viewport)
    const tableX = 0;  // Centered
    const tableZ = -15;  // Near the window inside the shoebox
    const tableTopWidth = 30;   // Fit within shoebox width
    const tableTopDepth = 18;
    const tableTopHeight = 3;
    const tableLegWidth = 2;
    const tableLegHeight = 12;
    const tableY = floorYAtZ(tableZ) + tableLegHeight;

    // Table top vertices
    const tableVertices = [
        // Table top (8 vertices for a box)
        tableX - tableTopWidth/2, tableY, tableZ - tableTopDepth/2,
        tableX + tableTopWidth/2, tableY, tableZ - tableTopDepth/2,
        tableX + tableTopWidth/2, tableY + tableTopHeight, tableZ - tableTopDepth/2,
        tableX - tableTopWidth/2, tableY + tableTopHeight, tableZ - tableTopDepth/2,
        tableX - tableTopWidth/2, tableY, tableZ + tableTopDepth/2,
        tableX + tableTopWidth/2, tableY, tableZ + tableTopDepth/2,
        tableX + tableTopWidth/2, tableY + tableTopHeight, tableZ + tableTopDepth/2,
        tableX - tableTopWidth/2, tableY + tableTopHeight, tableZ + tableTopDepth/2,

        // Table legs (4 legs, 8 vertices each = 32 vertices)
        // Front-left leg
        tableX - tableTopWidth/2 + tableLegWidth, tableY - tableLegHeight, tableZ - tableTopDepth/2 + tableLegWidth,
        tableX - tableTopWidth/2 + tableLegWidth*2, tableY - tableLegHeight, tableZ - tableTopDepth/2 + tableLegWidth,
        tableX - tableTopWidth/2 + tableLegWidth*2, tableY, tableZ - tableTopDepth/2 + tableLegWidth,
        tableX - tableTopWidth/2 + tableLegWidth, tableY, tableZ - tableTopDepth/2 + tableLegWidth,
        tableX - tableTopWidth/2 + tableLegWidth, tableY - tableLegHeight, tableZ - tableTopDepth/2 + tableLegWidth*2,
        tableX - tableTopWidth/2 + tableLegWidth*2, tableY - tableLegHeight, tableZ - tableTopDepth/2 + tableLegWidth*2,
        tableX - tableTopWidth/2 + tableLegWidth*2, tableY, tableZ - tableTopDepth/2 + tableLegWidth*2,
        tableX - tableTopWidth/2 + tableLegWidth, tableY, tableZ - tableTopDepth/2 + tableLegWidth*2,

        // Front-right leg
        tableX + tableTopWidth/2 - tableLegWidth*2, tableY - tableLegHeight, tableZ - tableTopDepth/2 + tableLegWidth,
        tableX + tableTopWidth/2 - tableLegWidth, tableY - tableLegHeight, tableZ - tableTopDepth/2 + tableLegWidth,
        tableX + tableTopWidth/2 - tableLegWidth, tableY, tableZ - tableTopDepth/2 + tableLegWidth,
        tableX + tableTopWidth/2 - tableLegWidth*2, tableY, tableZ - tableTopDepth/2 + tableLegWidth,
        tableX + tableTopWidth/2 - tableLegWidth*2, tableY - tableLegHeight, tableZ - tableTopDepth/2 + tableLegWidth*2,
        tableX + tableTopWidth/2 - tableLegWidth, tableY - tableLegHeight, tableZ - tableTopDepth/2 + tableLegWidth*2,
        tableX + tableTopWidth/2 - tableLegWidth, tableY, tableZ - tableTopDepth/2 + tableLegWidth*2,
        tableX + tableTopWidth/2 - tableLegWidth*2, tableY, tableZ - tableTopDepth/2 + tableLegWidth*2,

        // Back-left leg
        tableX - tableTopWidth/2 + tableLegWidth, tableY - tableLegHeight, tableZ + tableTopDepth/2 - tableLegWidth*2,
        tableX - tableTopWidth/2 + tableLegWidth*2, tableY - tableLegHeight, tableZ + tableTopDepth/2 - tableLegWidth*2,
        tableX - tableTopWidth/2 + tableLegWidth*2, tableY, tableZ + tableTopDepth/2 - tableLegWidth*2,
        tableX - tableTopWidth/2 + tableLegWidth, tableY, tableZ + tableTopDepth/2 - tableLegWidth*2,
        tableX - tableTopWidth/2 + tableLegWidth, tableY - tableLegHeight, tableZ + tableTopDepth/2 - tableLegWidth,
        tableX - tableTopWidth/2 + tableLegWidth*2, tableY - tableLegHeight, tableZ + tableTopDepth/2 - tableLegWidth,
        tableX - tableTopWidth/2 + tableLegWidth*2, tableY, tableZ + tableTopDepth/2 - tableLegWidth,
        tableX - tableTopWidth/2 + tableLegWidth, tableY, tableZ + tableTopDepth/2 - tableLegWidth,

        // Back-right leg
        tableX + tableTopWidth/2 - tableLegWidth*2, tableY - tableLegHeight, tableZ + tableTopDepth/2 - tableLegWidth*2,
        tableX + tableTopWidth/2 - tableLegWidth, tableY - tableLegHeight, tableZ + tableTopDepth/2 - tableLegWidth*2,
        tableX + tableTopWidth/2 - tableLegWidth, tableY, tableZ + tableTopDepth/2 - tableLegWidth*2,
        tableX + tableTopWidth/2 - tableLegWidth*2, tableY, tableZ + tableTopDepth/2 - tableLegWidth*2,
        tableX + tableTopWidth/2 - tableLegWidth*2, tableY - tableLegHeight, tableZ + tableTopDepth/2 - tableLegWidth,
        tableX + tableTopWidth/2 - tableLegWidth, tableY - tableLegHeight, tableZ + tableTopDepth/2 - tableLegWidth,
        tableX + tableTopWidth/2 - tableLegWidth, tableY, tableZ + tableTopDepth/2 - tableLegWidth,
        tableX + tableTopWidth/2 - tableLegWidth*2, tableY, tableZ + tableTopDepth/2 - tableLegWidth,
    ];

    const tableIndices = [
        // Table top
        0, 1, 2,  0, 2, 3,  // Bottom
        4, 6, 5,  4, 7, 6,  // Top
        0, 4, 5,  0, 5, 1,  // Front
        2, 6, 7,  2, 7, 3,  // Back
        0, 3, 7,  0, 7, 4,  // Left
        1, 5, 6,  1, 6, 2,  // Right

        // Front-left leg
        8, 9, 10,  8, 10, 11,  // Front
        12, 14, 13,  12, 15, 14,  // Back
        8, 12, 13,  8, 13, 9,  // Bottom
        10, 14, 15,  10, 15, 11,  // Top
        8, 11, 15,  8, 15, 12,  // Left
        9, 13, 14,  9, 14, 10,   // Right

        // Front-right leg
        16, 17, 18,  16, 18, 19,  // Front
        20, 22, 21,  20, 23, 22,  // Back
        16, 20, 21,  16, 21, 17,  // Bottom
        18, 22, 23,  18, 23, 19,  // Top
        16, 19, 23,  16, 23, 20,  // Left
        17, 21, 22,  17, 22, 18,  // Right

        // Back-left leg
        24, 25, 26,  24, 26, 27,  // Front
        28, 30, 29,  28, 31, 30,  // Back
        24, 28, 29,  24, 29, 25,  // Bottom
        26, 30, 31,  26, 31, 27,  // Top
        24, 27, 31,  24, 31, 28,  // Left
        25, 29, 30,  25, 30, 26,  // Right

        // Back-right leg
        32, 33, 34,  32, 34, 35,  // Front
        36, 38, 37,  36, 39, 38,  // Back
        32, 36, 37,  32, 37, 33,  // Bottom
        34, 38, 39,  34, 39, 35,  // Top
        32, 35, 39,  32, 39, 36,  // Left
        33, 37, 38,  33, 38, 34,  // Right
    ];

    // Object 2: Chair (rotated 90 degrees, to the side of table)
    const chairZ = -20;  // Within shoebox depth
    const chairX = -15;  // Left of table
    const chairY = floorYAtZ(chairZ);  // Rest on the floor
    const chairSeatSize = 16;  // Compact chair
    const chairBackHeight = 20;
    const chairSeatHeight = 12;  // Leg height from floor to seat
    const chairLegWidth = 1.2;
    const chairRotated = true;  // Flag for 90-degree rotation

    const chairVertices = [
        // Seat (8 vertices) - ROTATED 90 DEGREES (swap X and Z dimensions)
        chairX - chairSeatSize/2, chairY + chairSeatHeight, chairZ - chairSeatSize/2,
        chairX - chairSeatSize/2, chairY + chairSeatHeight, chairZ + chairSeatSize/2,
        chairX - chairSeatSize/2, chairY + chairSeatHeight + 3, chairZ + chairSeatSize/2,
        chairX - chairSeatSize/2, chairY + chairSeatHeight + 3, chairZ - chairSeatSize/2,
        chairX + chairSeatSize/2, chairY + chairSeatHeight, chairZ - chairSeatSize/2,
        chairX + chairSeatSize/2, chairY + chairSeatHeight, chairZ + chairSeatSize/2,
        chairX + chairSeatSize/2, chairY + chairSeatHeight + 3, chairZ + chairSeatSize/2,
        chairX + chairSeatSize/2, chairY + chairSeatHeight + 3, chairZ - chairSeatSize/2,

        // Back (8 vertices) - now on the LEFT SIDE when viewed from front
        chairX - chairSeatSize/2, chairY + chairSeatHeight, chairZ - chairSeatSize/2,
        chairX - chairSeatSize/2, chairY + chairSeatHeight, chairZ + chairSeatSize/2,
        chairX - chairSeatSize/2, chairY + chairSeatHeight + chairBackHeight, chairZ + chairSeatSize/2,
        chairX - chairSeatSize/2, chairY + chairSeatHeight + chairBackHeight, chairZ - chairSeatSize/2,
        chairX - chairSeatSize/2 + 3, chairY + chairSeatHeight, chairZ - chairSeatSize/2,
        chairX - chairSeatSize/2 + 3, chairY + chairSeatHeight, chairZ + chairSeatSize/2,
        chairX - chairSeatSize/2 + 3, chairY + chairSeatHeight + chairBackHeight, chairZ + chairSeatSize/2,
        chairX - chairSeatSize/2 + 3, chairY + chairSeatHeight + chairBackHeight, chairZ - chairSeatSize/2,

        // Four chair legs - ROTATED (positioned for sideways chair)
        // Near-left leg
        chairX - chairSeatSize/2 + chairLegWidth, chairY, chairZ - chairSeatSize/2 + chairLegWidth,
        chairX - chairSeatSize/2 + chairLegWidth*2, chairY, chairZ - chairSeatSize/2 + chairLegWidth,
        chairX - chairSeatSize/2 + chairLegWidth*2, chairY + chairSeatHeight, chairZ - chairSeatSize/2 + chairLegWidth,
        chairX - chairSeatSize/2 + chairLegWidth, chairY + chairSeatHeight, chairZ - chairSeatSize/2 + chairLegWidth,
        chairX - chairSeatSize/2 + chairLegWidth, chairY, chairZ - chairSeatSize/2 + chairLegWidth*2,
        chairX - chairSeatSize/2 + chairLegWidth*2, chairY, chairZ - chairSeatSize/2 + chairLegWidth*2,
        chairX - chairSeatSize/2 + chairLegWidth*2, chairY + chairSeatHeight, chairZ - chairSeatSize/2 + chairLegWidth*2,
        chairX - chairSeatSize/2 + chairLegWidth, chairY + chairSeatHeight, chairZ - chairSeatSize/2 + chairLegWidth*2,

        // Near-right leg
        chairX - chairSeatSize/2 + chairLegWidth, chairY, chairZ + chairSeatSize/2 - chairLegWidth*2,
        chairX - chairSeatSize/2 + chairLegWidth*2, chairY, chairZ + chairSeatSize/2 - chairLegWidth*2,
        chairX - chairSeatSize/2 + chairLegWidth*2, chairY + chairSeatHeight, chairZ + chairSeatSize/2 - chairLegWidth*2,
        chairX - chairSeatSize/2 + chairLegWidth, chairY + chairSeatHeight, chairZ + chairSeatSize/2 - chairLegWidth*2,
        chairX - chairSeatSize/2 + chairLegWidth, chairY, chairZ + chairSeatSize/2 - chairLegWidth,
        chairX - chairSeatSize/2 + chairLegWidth*2, chairY, chairZ + chairSeatSize/2 - chairLegWidth,
        chairX - chairSeatSize/2 + chairLegWidth*2, chairY + chairSeatHeight, chairZ + chairSeatSize/2 - chairLegWidth,
        chairX - chairSeatSize/2 + chairLegWidth, chairY + chairSeatHeight, chairZ + chairSeatSize/2 - chairLegWidth,

        // Far-left leg
        chairX + chairSeatSize/2 - chairLegWidth*2, chairY, chairZ - chairSeatSize/2 + chairLegWidth,
        chairX + chairSeatSize/2 - chairLegWidth, chairY, chairZ - chairSeatSize/2 + chairLegWidth,
        chairX + chairSeatSize/2 - chairLegWidth, chairY + chairSeatHeight, chairZ - chairSeatSize/2 + chairLegWidth,
        chairX + chairSeatSize/2 - chairLegWidth*2, chairY + chairSeatHeight, chairZ - chairSeatSize/2 + chairLegWidth,
        chairX + chairSeatSize/2 - chairLegWidth*2, chairY, chairZ - chairSeatSize/2 + chairLegWidth*2,
        chairX + chairSeatSize/2 - chairLegWidth, chairY, chairZ - chairSeatSize/2 + chairLegWidth*2,
        chairX + chairSeatSize/2 - chairLegWidth, chairY + chairSeatHeight, chairZ - chairSeatSize/2 + chairLegWidth*2,
        chairX + chairSeatSize/2 - chairLegWidth*2, chairY + chairSeatHeight, chairZ - chairSeatSize/2 + chairLegWidth*2,

        // Far-right leg
        chairX + chairSeatSize/2 - chairLegWidth*2, chairY, chairZ + chairSeatSize/2 - chairLegWidth*2,
        chairX + chairSeatSize/2 - chairLegWidth, chairY, chairZ + chairSeatSize/2 - chairLegWidth*2,
        chairX + chairSeatSize/2 - chairLegWidth, chairY + chairSeatHeight, chairZ + chairSeatSize/2 - chairLegWidth*2,
        chairX + chairSeatSize/2 - chairLegWidth*2, chairY + chairSeatHeight, chairZ + chairSeatSize/2 - chairLegWidth*2,
        chairX + chairSeatSize/2 - chairLegWidth*2, chairY, chairZ + chairSeatSize/2 - chairLegWidth,
        chairX + chairSeatSize/2 - chairLegWidth, chairY, chairZ + chairSeatSize/2 - chairLegWidth,
        chairX + chairSeatSize/2 - chairLegWidth, chairY + chairSeatHeight, chairZ + chairSeatSize/2 - chairLegWidth,
        chairX + chairSeatSize/2 - chairLegWidth*2, chairY + chairSeatHeight, chairZ + chairSeatSize/2 - chairLegWidth,
    ];

    const chairIndices = [
        // Seat
        0, 1, 2,  0, 2, 3,
        4, 6, 5,  4, 7, 6,
        0, 4, 5,  0, 5, 1,
        2, 6, 7,  2, 7, 3,
        0, 3, 7,  0, 7, 4,
        1, 5, 6,  1, 6, 2,

        // Back
        8, 9, 10,  8, 10, 11,
        12, 14, 13,  12, 15, 14,
        8, 12, 13,  8, 13, 9,
        10, 14, 15,  10, 15, 11,
        8, 11, 15,  8, 15, 12,
        9, 13, 14,  9, 14, 10,

        // Front-left leg
        16, 17, 18,  16, 18, 19,
        20, 22, 21,  20, 23, 22,
        16, 20, 21,  16, 21, 17,
        18, 22, 23,  18, 23, 19,
        16, 19, 23,  16, 23, 20,
        17, 21, 22,  17, 22, 18,

        // Front-right leg
        24, 25, 26,  24, 26, 27,
        28, 30, 29,  28, 31, 30,
        24, 28, 29,  24, 29, 25,
        26, 30, 31,  26, 31, 27,
        24, 27, 31,  24, 31, 28,
        25, 29, 30,  25, 30, 26,

        // Back-left leg
        32, 33, 34,  32, 34, 35,
        36, 38, 37,  36, 39, 38,
        32, 36, 37,  32, 37, 33,
        34, 38, 39,  34, 39, 35,
        32, 35, 39,  32, 39, 36,
        33, 37, 38,  33, 38, 34,

        // Back-right leg
        40, 41, 42,  40, 42, 43,
        44, 46, 45,  44, 47, 46,
        40, 44, 45,  40, 45, 41,
        42, 46, 47,  42, 47, 43,
        40, 43, 47,  40, 47, 44,
        41, 45, 46,  41, 46, 42,
    ];

    // Object 3: Ball (center floor, far)
    const ballRadius = 8;
    const ballX = -10;
    const ballZ = -30;  // Within shoebox depth
    const ballY = floorYAtZ(ballZ) + ballRadius;  // Resting on floor

    // Create sphere vertices (simplified icosahedron)
    const t = (1.0 + Math.sqrt(5.0)) / 2.0;
    const ballVertices = [];
    const baseVerts = [
        [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
        [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
        [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]
    ];

    for (let vert of baseVerts) {
        const len = Math.sqrt(vert[0]*vert[0] + vert[1]*vert[1] + vert[2]*vert[2]);
        ballVertices.push(
            ballX + vert[0] / len * ballRadius,
            ballY + vert[1] / len * ballRadius,
            ballZ + vert[2] / len * ballRadius
        );
    }

    const ballIndices = [
        0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
        1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
        3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
        4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1
    ];

    // Object 4: Ceiling lamp (hanging from ceiling)
    const lampX = 20;
    const lampZ = -35;  // Within shoebox depth
    const lampCordLength = 10;
    const lampY = ceilingYAtZ(lampZ) - lampCordLength;  // Attach to ceiling
    const lampShadeRadius = 10;
    const lampShadeHeight = 8;

    const lampVertices = [
        // Lamp shade (inverted cone - wider at bottom)
        lampX, lampY, lampZ,  // Apex (top of shade, where cord connects)
        // Octagon base points (at bottom of shade)
        lampX + lampShadeRadius, lampY - lampShadeHeight, lampZ,
        lampX + lampShadeRadius * 0.7, lampY - lampShadeHeight, lampZ + lampShadeRadius * 0.7,
        lampX, lampY - lampShadeHeight, lampZ + lampShadeRadius,
        lampX - lampShadeRadius * 0.7, lampY - lampShadeHeight, lampZ + lampShadeRadius * 0.7,
        lampX - lampShadeRadius, lampY - lampShadeHeight, lampZ,
        lampX - lampShadeRadius * 0.7, lampY - lampShadeHeight, lampZ - lampShadeRadius * 0.7,
        lampX, lampY - lampShadeHeight, lampZ - lampShadeRadius,
        lampX + lampShadeRadius * 0.7, lampY - lampShadeHeight, lampZ - lampShadeRadius * 0.7,

        // Lamp cord (thin cylinder connecting to ceiling)
        lampX - 1, lampY, lampZ - 1,
        lampX + 1, lampY, lampZ - 1,
        lampX + 1, lampY + lampCordLength, lampZ - 1,
        lampX - 1, lampY + lampCordLength, lampZ - 1,
        lampX - 1, lampY, lampZ + 1,
        lampX + 1, lampY, lampZ + 1,
        lampX + 1, lampY + lampCordLength, lampZ + 1,
        lampX - 1, lampY + lampCordLength, lampZ + 1,
    ];

    const lampIndices = [
        // Lamp shade triangles
        0, 1, 2,
        0, 2, 3,
        0, 3, 4,
        0, 4, 5,
        0, 5, 6,
        0, 6, 7,
        0, 7, 8,
        0, 8, 1,
        // Shade base
        1, 2, 3,  1, 3, 5,  1, 5, 7,  1, 7, 8,  3, 4, 5,  5, 6, 7,

        // Cord
        9, 10, 11,  9, 11, 12,
        13, 15, 14,  13, 16, 15,
        9, 13, 14,  9, 14, 10,
        11, 15, 16,  11, 16, 12,
        9, 12, 16,  9, 16, 13,
        10, 14, 15,  10, 15, 11,
    ];

    // Set up buffers and render each object
    const positionBuffer = gl.createBuffer();
    const indexBuffer = gl.createBuffer();

    // Render chair FIRST (it's further away at Z=-95)
    const chairTexCoords = new Array(48 * 2).fill(0).map((_, i) => (i % 4 < 2) ? 0 : 1);  // 16 seat/back + 32 legs

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(chairVertices), gl.STATIC_DRAW);
    gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(chairTexCoords), gl.STATIC_DRAW);
    gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(chairIndices), gl.STATIC_DRAW);

    gl.uniform1i(surfaceTypeLocation, 5); // Use orange texture for chair
    gl.uniformMatrix4fv(mvpLocation, false, mvpMatrix);
    gl.drawElements(gl.TRIANGLES, chairIndices.length, gl.UNSIGNED_SHORT, 0);

    // Render table SECOND (it's closer at Z=-80, will occlude chair)
    const tableTexCoords = new Array(40 * 2).fill(0).map((_, i) => (i % 4 < 2) ? 0 : 1); // UV coords for table vertices (8 top + 32 legs)

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tableVertices), gl.STATIC_DRAW);
    gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(tableTexCoords), gl.STATIC_DRAW);
    gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(tableIndices), gl.STATIC_DRAW);

    gl.uniform1i(surfaceTypeLocation, 4); // Use green texture for table
    gl.uniformMatrix4fv(mvpLocation, false, mvpMatrix);
    gl.drawElements(gl.TRIANGLES, tableIndices.length, gl.UNSIGNED_SHORT, 0);

    // Render ball with solid color texture (create stable UVs)
    const ballTexCoords = new Array(12 * 2).fill(0).map((_, i) => {
        // Create stable UV coordinates based on vertex index
        const vertIndex = Math.floor(i / 2);
        return (i % 2 === 0) ? vertIndex / 12 : 1 - vertIndex / 12;
    });

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(ballVertices), gl.STATIC_DRAW);
    gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(ballTexCoords), gl.STATIC_DRAW);
    gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(ballIndices), gl.STATIC_DRAW);

    gl.uniform1i(surfaceTypeLocation, 0); // Use checkered floor texture for ball
    gl.drawElements(gl.TRIANGLES, ballIndices.length, gl.UNSIGNED_SHORT, 0);

    // Render ceiling lamp with metallic/yellow color
    const lampTexCoords = new Array(17 * 2).fill(0).map((_, i) => (i % 4 < 2) ? 0 : 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lampVertices), gl.STATIC_DRAW);
    gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, texCoordBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lampTexCoords), gl.STATIC_DRAW);
    gl.vertexAttribPointer(texCoordLocation, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(lampIndices), gl.STATIC_DRAW);

    // Create a special texture for the lamp (yellowish metallic)
    gl.uniform1i(surfaceTypeLocation, 3); // Use a different texture type for lamp
    gl.drawElements(gl.TRIANGLES, lampIndices.length, gl.UNSIGNED_SHORT, 0);
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

    // Far rectangle (same size as near; open viewport at near face)
    const farCorners = [
        toIsometric(-corridorWidth/2, -corridorHeight/2, corridorFar),
        toIsometric(corridorWidth/2, -corridorHeight/2, corridorFar),
        toIsometric(corridorWidth/2, corridorHeight/2, corridorFar),
        toIsometric(-corridorWidth/2, corridorHeight/2, corridorFar)
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

    // Draw objects in the corridor (for debugging)
    // Table (green dot - near the window)
    ctx.fillStyle = '#4CAF50';
    const tablePos = toIsometric(0, -5, -15);
    ctx.beginPath();
    ctx.arc(tablePos.x, tablePos.y, 8, 0, Math.PI * 2);
    ctx.fill();

    // Chair (orange dot - to the left side)
    ctx.fillStyle = '#FF9800';
    const chairPos = toIsometric(-15, -5, -20);
    ctx.beginPath();
    ctx.arc(chairPos.x, chairPos.y, 6, 0, Math.PI * 2);
    ctx.fill();

    // Ball (yellow dot)
    ctx.fillStyle = '#ffff00';
    const ballPos = toIsometric(-10, -9, -30);
    ctx.beginPath();
    ctx.arc(ballPos.x, ballPos.y, 5, 0, Math.PI * 2);
    ctx.fill();

    // Lamp (orange dot)
    ctx.fillStyle = '#ff8800';
    const lampPos = toIsometric(20, 8, -35);
    ctx.beginPath();
    ctx.arc(lampPos.x, lampPos.y, 5, 0, Math.PI * 2);
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

        // Store as last valid position
        lastValidHeadPosition.x = headPosition.x;
        lastValidHeadPosition.y = headPosition.y;
        lastValidHeadPosition.z = headPosition.z;
        hasTrackedAtLeastOnce = true;
    } else {
        document.getElementById('faceDetected').textContent = 'No (using last position)';
        lastDetectionBbox = null;

        // When face is lost, use last valid position if we had one
        if (hasTrackedAtLeastOnce) {
            headPosition.x = lastValidHeadPosition.x;
            headPosition.y = lastValidHeadPosition.y;
            headPosition.z = lastValidHeadPosition.z;

            // Update display with last known position
            document.getElementById('headX').textContent = headPosition.x.toFixed(1);
            document.getElementById('headY').textContent = headPosition.y.toFixed(1);
            document.getElementById('headZ').textContent = headPosition.z.toFixed(1);
        }
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
    // INVERT the X axis because camera sees mirror image
    // When face moves right in camera, user actually moved left
    const rawX = -(horizontalPixelOffset / videoWidth) * SCREEN_WIDTH_CM + CAMERA_OFFSET_X;
    const rawY = -(verticalPixelOffset / videoHeight) * SCREEN_HEIGHT_CM + CAMERA_OFFSET_Y;

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
        if (hasTrackedAtLeastOnce) {
            document.getElementById('trackingStatus').textContent = 'Off (using last position)';
        } else {
            document.getElementById('trackingStatus').textContent = 'Off';
        }
        document.getElementById('trackingBtn').textContent = 'Start Head Tracking';
        overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
        // Don't stop the camera, just stop processing
        // Keep using last valid position
        if (hasTrackedAtLeastOnce) {
            headPosition.x = lastValidHeadPosition.x;
            headPosition.y = lastValidHeadPosition.y;
            headPosition.z = lastValidHeadPosition.z;
        }
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
    // Generate spots after constants are defined
    for (let i = 0; i < NUM_SPOTS; i++) {
        // Use index as seed for deterministic randomness
        const x = (seededRandom(i * 3) - 0.5) * CORRIDOR_WIDTH * 0.9;
        const y = (seededRandom(i * 3 + 1) - 0.5) * CORRIDOR_HEIGHT * 0.9;
        const z = CORRIDOR_NEAR - seededRandom(i * 3 + 2) * (Math.abs(CORRIDOR_FAR - CORRIDOR_NEAR) * 0.9);

        // Random color for each spot
        const r = seededRandom(i * 3 + 100);
        const g = seededRandom(i * 3 + 200);
        const b = seededRandom(i * 3 + 300);

        spots.push({ x, y, z, r, g, b });
    }

    // Get DOM elements
    video = document.getElementById('video');
    overlayCanvas = document.getElementById('canvas-overlay');
    overlayCtx = overlayCanvas.getContext('2d');

    if (initWebGL()) {
        console.log('WebGL initialized successfully');
        initializeFaceDetection();

        // Load the STL models
        loadSTL();
        loadCatSTL();

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

    // No resolution uniform needed for wireframe shader
    if (gl && program) {
        gl.viewport(0, 0, canvas.width, canvas.height);
    }
});
