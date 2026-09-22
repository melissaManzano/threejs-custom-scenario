import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import RAPIER from 'https://cdn.skypack.dev/@dimforge/rapier3d-compat';

await RAPIER.init();

const container = document.getElementById('scene-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07111f);

const camera = new THREE.PerspectiveCamera(
    60, window.innerWidth / window.innerHeight, 0.1, 1500
);
camera.position.set(3, 4, 8); // Punto de spawn en zona de calle abierta del nuevo modelo de ciudad.

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
container.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x202020, 1.7));
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.position.set(-10, 25, 10);
sun.castShadow = true;
scene.add(sun);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.enablePan = false;
controls.minDistance = 3;
controls.maxDistance = 14;

const physicsWorld = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const loader = new GLTFLoader();
const timer = new THREE.Timer();

// La ciudad trae miles de meshes modulares; crear un collider trimesh por
// mesh sería demasiado lento (broad-phase de Rapier + tiempo de build), así
// que se fusiona toda la geometría en un único trimesh estático.
function buildCityCollider(city) {
    let vertexTotal = 0;
    let indexTotal = 0;
    const meshes = [];

    city.traverse((child) => {
        if (!child.isMesh) return;
        const position = child.geometry.attributes.position;
        if (!position) return;
        meshes.push(child);
        vertexTotal += position.count;
        indexTotal += child.geometry.index ? child.geometry.index.count : position.count;
    });

    const vertices = new Float32Array(vertexTotal * 3);
    const indices = new Uint32Array(indexTotal);
    const point = new THREE.Vector3();
    let vertexOffset = 0;
    let indexOffset = 0;

    for (const mesh of meshes) {
        mesh.updateWorldMatrix(true, false);
        const position = mesh.geometry.attributes.position;
        const baseVertex = vertexOffset;

        for (let i = 0; i < position.count; i++) {
            point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
            vertices[vertexOffset * 3] = point.x;
            vertices[vertexOffset * 3 + 1] = point.y;
            vertices[vertexOffset * 3 + 2] = point.z;
            vertexOffset++;
        }

        if (mesh.geometry.index) {
            const idx = mesh.geometry.index.array;
            for (let i = 0; i < idx.length; i++) indices[indexOffset++] = idx[i] + baseVertex;
        } else {
            for (let i = 0; i < position.count; i++) indices[indexOffset++] = i + baseVertex;
        }
    }

    physicsWorld.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices));
}

let cityReady = false;

loader.load('./assets/models/city/scene.gltf', (gltf) => {
    const city = gltf.scene;
    city.traverse((child) => {
        if (!child.isMesh) return;
        child.castShadow = true;
        child.receiveShadow = true;
    });
    buildCityCollider(city);
    scene.add(city);
    cityReady = true; // El collider de la ciudad ya existe; recién ahora es seguro aplicar física al personaje.
});

const characterBody = physicsWorld.createRigidBody(
    RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(3, 1.1, 0)
);
const characterCollider = physicsWorld.createCollider(
    RAPIER.ColliderDesc.capsule(0.8, 0.35),
    characterBody
);

const characterController = physicsWorld.createCharacterController(0.03);
characterController.enableAutostep(0.35, 0.2, true);
characterController.enableSnapToGround(0.35);
characterController.setApplyImpulsesToDynamicBodies(true);

const keyStates = {};
document.addEventListener('keydown', e => keyStates[e.code] = true);
document.addEventListener('keyup', e => keyStates[e.code] = false);

let character = null;
let mixer = null;
const actions = {};
let currentAction = null;
let isThrowing = false;
let rightHandBone = null;

async function loadAnimationClip(url, name) {
    const gltf = await loader.loadAsync(url);
    const clip = gltf.animations[0];
    clip.name = name;
    return clip;
}

async function initCharacter() {
    const [characterGltf, idleClip, walkClip, runClip, throwClip] = await Promise.all([
        loader.loadAsync('./assets/models/character/character.gltf'),
        loadAnimationClip('./assets/models/props/Idle.gltf', 'idle'),
        loadAnimationClip('./assets/models/props/Walking.gltf', 'walk'),
        loadAnimationClip('./assets/models/props/Fast Run.gltf', 'run'),
        loadAnimationClip('./assets/models/props/Throw Object.gltf', 'throw'),
    ]);

    character = characterGltf.scene;
    character.scale.setScalar(1.0); // Ajusta a la escala del escenario.
    character.traverse((child) => {
        if (child.isMesh) child.castShadow = true;
    });
    scene.add(character);
    rightHandBone = character.getObjectByName('mixamorigRightHand');

    mixer = new THREE.AnimationMixer(character);
    for (const clip of [idleClip, walkClip, runClip, throwClip]) {
        actions[clip.name] = mixer.clipAction(clip);
    }
    actions.throw.setLoop(THREE.LoopOnce);
    actions.throw.clampWhenFinished = true;
    mixer.addEventListener('finished', (event) => {
        if (event.action === actions.throw) isThrowing = false;
    });

    playAction('idle');
}

initCharacter();

function playAction(name) {
    const next = actions[name];
    if (!next || next === currentAction) return;
    currentAction?.fadeOut(0.2);
    next.reset().fadeIn(0.2).play();
    currentAction = next;
}

const desired = new THREE.Vector3();
const forward = new THREE.Vector3();
const side = new THREE.Vector3();

function updateCharacter(delta) {
    if (!character) return;

    camera.getWorldDirection(forward);
    forward.y = 0;
    forward.normalize();
    side.crossVectors(forward, camera.up).normalize();

    desired.set(0, -4.5 * delta, 0); // gravedad del personaje
    const running = keyStates.ShiftLeft || keyStates.ShiftRight;
    const speed = running ? 5.5 : 3.0;

    const move = new THREE.Vector3();
    if (keyStates.KeyW) move.add(forward);
    if (keyStates.KeyS) move.sub(forward);
    if (keyStates.KeyD) move.add(side);
    if (keyStates.KeyA) move.sub(side);

    if (move.lengthSq() > 0) {
        move.normalize();
        desired.addScaledVector(move, speed * delta);
        character.rotation.y = Math.atan2(move.x, move.z);
        if (!isThrowing) playAction(running ? 'run' : 'walk');
    } else if (!isThrowing) {
        playAction('idle');
    }

    characterController.computeColliderMovement(characterCollider, desired);
    const corrected = characterController.computedMovement();
    const p = characterBody.translation();
    characterBody.setNextKinematicTranslation({
        x: p.x + corrected.x,
        y: p.y + corrected.y,
        z: p.z + corrected.z
    });
}

function syncCharacter() {
    if (!character) return;
    const p = characterBody.translation();
    character.position.set(p.x, p.y - 1.0, p.z);

    controls.target.set(p.x, p.y + 0.7, p.z);
    controls.update();
}

const dynamicObjects = [];

function createBox(x, y, z, sx = 1, sy = 1, sz = 1, mass = 3) {
    const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(sx, sy, sz),
        new THREE.MeshStandardMaterial({ color: 0x9aa7b8, roughness: 0.7 })
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);

    const body = physicsWorld.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y, z)
    );
    const collider = RAPIER.ColliderDesc.cuboid(sx / 2, sy / 2, sz / 2)
        .setMass(mass)
        .setFriction(0.7)
        .setRestitution(0.1);
    physicsWorld.createCollider(collider, body);
    dynamicObjects.push({ mesh, body });
}

// Pirámide de cajas.
for (let level = 0; level < 3; level++) {
    for (let i = 0; i < 3 - level; i++) {
        createBox(3 + i * 1.1 + level * 0.55, 0.55 + level, 4, 1, 1, 1, 4);
    }
}

// Instante (en segundos, dentro del clip "throw") en el que la mano queda
// totalmente extendida hacia adelante: medido muestreando el hueso
// mixamorigRightHand a lo largo del clip (pico de alcance en ~2.55s de 4.9s).
const THROW_RELEASE_DELAY = 2500;

document.addEventListener('keydown', (event) => {
    if (event.code === 'KeyF' && !event.repeat) throwObject();
});

function throwObject() {
    if (!character || isThrowing) return;
    isThrowing = true;
    playAction('throw');
    setTimeout(releaseObject, THROW_RELEASE_DELAY);
}

function releaseObject() {
    const dir = new THREE.Vector3(0, 0, 1)
        .applyQuaternion(character.quaternion)
        .normalize();

    const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 16, 16),
        new THREE.MeshStandardMaterial({ color: 0x22d3ee, emissive: 0x063b49 })
    );
    scene.add(mesh);

    // Sale desde la posición real del hueso de la mano en el instante del release.
    const start = new THREE.Vector3();
    rightHandBone.getWorldPosition(start);

    const body = physicsWorld.createRigidBody(
        RAPIER.RigidBodyDesc.dynamic().setTranslation(start.x, start.y, start.z)
    );
    physicsWorld.createCollider(RAPIER.ColliderDesc.ball(0.18).setRestitution(0.25), body);
    body.setLinvel({ x: dir.x * 13, y: 2.2, z: dir.z * 13 }, true);

    dynamicObjects.push({ mesh, body });
}

function syncDynamicObjects() {
    for (const item of dynamicObjects) {
        const p = item.body.translation();
        const q = item.body.rotation();
        item.mesh.position.set(p.x, p.y, p.z);
        item.mesh.quaternion.set(q.x, q.y, q.z, q.w);
    }
}

function animate() {
    timer.update();
    const delta = Math.min(0.05, timer.getDelta());

    // No se avanza la física hasta que existan los colliders de la ciudad:
    // si el personaje o las cajas caen antes de eso, atraviesan el suelo
    // en caída libre y quedan encajados bajo la malla cuando por fin se crea.
    if (cityReady) {
        updateCharacter(delta);
        physicsWorld.timestep = delta;
        physicsWorld.step();
        syncCharacter();
        syncDynamicObjects();
    }
    if (mixer) mixer.update(delta);

    renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});