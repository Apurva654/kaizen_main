const LANES = [-4.8, -2.4, 0.0, 2.4, 4.8];
let currentLane = 2;
let score = 0;
let coins = 0;
let gamePlaying = false;
let speed = 0.6;
let isCountingDown = false;

let scene, camera, renderer, player, inspector;
let obstacles = [];
let collectibleCoins = [];
let powerUps = [];
let trackSegments = [];
let particles = [];
let clouds = [];

const playerState = {
    yVelocity: 0,
    isJumping: false,
    isDuck: false,
    jumpPower: 0.4,
    gravity: 0.02,
    shieldActive: false,
    powerupTimer: 0,
    powerupType: null
};

function init() {
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a8cff);
    scene.fog = new THREE.FogExp2(0x1a8cff, 0.012);

    camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 5, 11);
    camera.lookAt(0, 1.5, -5);

    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    document.body.appendChild(renderer.domElement);

    const ambientLight = new THREE.AmbientLight(0xffffff, 0.8);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xfffaed, 1.0);
    dirLight.position.set(20, 40, 20);
    dirLight.castShadow = true;
    scene.add(dirLight);

    createPlayer();
    createInspector();
    createTrack();
    createClouds();

    window.addEventListener('resize', onWindowResize);
    window.addEventListener('keydown', handleKeyDown);

    document.getElementById('start-btn').addEventListener('click', startCountdown);
    document.getElementById('restart-btn').addEventListener('click', restartGame);

    animate();
}

function createPlayer() {
    const group = new THREE.Group();

    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x00d2ff, roughness: 0.2, metalness: 0.8 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0xffdbac, roughness: 0.5 });
    const limbsMat = new THREE.MeshStandardMaterial({ color: 0x222244, roughness: 0.4 });
    const jacketMat = new THREE.MeshStandardMaterial({ color: 0xff2a6d, roughness: 0.3 });
    const hairMat = new THREE.MeshStandardMaterial({ color: 0x331100, roughness: 0.6 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.9, 0.35), bodyMat);
    body.position.y = 1.0;
    body.castShadow = true;
    group.add(body);

    const hoodie = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.65, 0.4), jacketMat);
    hoodie.position.y = 1.15;
    group.add(hoodie);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.42), headMat);
    head.position.y = 1.68;
    head.castShadow = true;
    group.add(head);

    const hair = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.18, 0.46), hairMat);
    hair.position.set(0, 1.9, -0.02);
    group.add(hair);

    const leftLegGroup = new THREE.Group();
    leftLegGroup.position.set(-0.16, 0.55, 0);
    const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.65, 0.18), limbsMat);
    leftLeg.position.y = -0.32;
    leftLegGroup.add(leftLeg);
    group.add(leftLegGroup);
    group.userData.leftLeg = leftLegGroup;

    const rightLegGroup = new THREE.Group();
    rightLegGroup.position.set(0.16, 0.55, 0);
    const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.65, 0.18), limbsMat);
    rightLeg.position.y = -0.32;
    rightLegGroup.add(rightLeg);
    group.add(rightLegGroup);
    group.userData.rightLeg = rightLegGroup;

    const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.6, 0.16), limbsMat);
    leftArm.position.set(-0.42, 1.05, 0);
    group.add(leftArm);
    group.userData.leftArm = leftArm;

    const rightArm = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.6, 0.16), limbsMat);
    rightArm.position.set(0.42, 1.05, 0);
    group.add(rightArm);
    group.userData.rightArm = rightArm;

    group.position.set(LANES[currentLane], 0, 0);
    scene.add(group);
    player = group;
}

function createInspector() {
    const group = new THREE.Group();

    const coatMat = new THREE.MeshStandardMaterial({ color: 0x1c3b57, roughness: 0.4 });
    const hatMat = new THREE.MeshStandardMaterial({ color: 0x0f2537, roughness: 0.3 });
    const faceMat = new THREE.MeshStandardMaterial({ color: 0xffdbac, roughness: 0.5 });
    const dogMat = new THREE.MeshStandardMaterial({ color: 0x8b5a2b });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.85, 1.35, 0.55), coatMat);
    body.position.y = 1.1;
    body.castShadow = true;
    group.add(body);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), faceMat);
    head.position.y = 1.92;
    group.add(head);

    const inspectorHat = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.22, 0.68), hatMat);
    inspectorHat.position.set(0, 2.22, -0.05);
    group.add(inspectorHat);

    const dogBody = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, 0.85), dogMat);
    dogBody.position.set(0.85, 0.35, 0.2);
    group.add(dogBody);

    const dogHead = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), dogMat);
    dogHead.position.set(0.85, 0.55, 0.65);
    group.add(dogHead);

    group.position.set(LANES[currentLane], 0, 15);
    group.visible = false;
    scene.add(group);
    inspector = group;
}

function createTrack() {
    const trackGeo = new THREE.BoxGeometry(16.5, 0.2, 120);
    const trackMat = new THREE.MeshStandardMaterial({ color: 0x22222a, roughness: 0.6 });
    
    for (let i = 0; i < 3; i++) {
        const track = new THREE.Mesh(trackGeo, trackMat);
        track.position.set(0, -0.1, -60 * i);
        scene.add(track);
        trackSegments.push(track);
    }

    LANES.forEach(xPos => {
        for (let i = 0; i < 3; i++) {
            for (let z = -60; z < 60; z += 2) {
                const sleeper = new THREE.Mesh(
                    new THREE.BoxGeometry(1.8, 0.08, 0.3),
                    new THREE.MeshStandardMaterial({ color: 0x5c4033, roughness: 0.8 })
                );
                sleeper.position.set(xPos, 0.02, z - (60 * i));
                scene.add(sleeper);
                trackSegments.push(sleeper);
            }

            const railMat = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 0.9, roughness: 0.1 });
            const leftRail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.15, 120), railMat);
            leftRail.position.set(xPos - 0.7, 0.08, -60 * i);
            scene.add(leftRail);
            trackSegments.push(leftRail);

            const rightRail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.15, 120), railMat);
            rightRail.position.set(xPos + 0.7, 0.08, -60 * i);
            scene.add(rightRail);
            trackSegments.push(rightRail);
        }
    });

    const wallMat = new THREE.MeshStandardMaterial({ color: 0x334466, roughness: 0.4 });
    for (let i = 0; i < 3; i++) {
        const leftWall = new THREE.Mesh(new THREE.BoxGeometry(0.6, 5, 120), wallMat);
        leftWall.position.set(-8.4, 2.5, -60 * i);
        scene.add(leftWall);
        trackSegments.push(leftWall);

        const rightWall = new THREE.Mesh(new THREE.BoxGeometry(0.6, 5, 120), wallMat);
        rightWall.position.set(8.4, 2.5, -60 * i);
        scene.add(rightWall);
        trackSegments.push(rightWall);
    }
}

function createClouds() {
    const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
    for (let i = 0; i < 15; i++) {
        const cloudGroup = new THREE.Group();
        for (let c = 0; c < 3; c++) {
            const puff = new THREE.Mesh(new THREE.SphereGeometry(Math.random() * 2 + 1.5, 7, 7), cloudMat);
            puff.position.set((Math.random() - 0.5) * 4, Math.random() * 1, (Math.random() - 0.5) * 4);
            cloudGroup.add(puff);
        }
        cloudGroup.position.set((Math.random() - 0.5) * 80, Math.random() * 15 + 15, (Math.random() - 0.5) * 120);
        scene.add(cloudGroup);
        clouds.push(cloudGroup);
    }
}

function spawnParticles(x, y, z, color, count = 12) {
    for (let i = 0; i < count; i++) {
        const pGeo = new THREE.BoxGeometry(0.15, 0.15, 0.15);
        const pMat = new THREE.MeshBasicMaterial({ color: color });
        const particle = new THREE.Mesh(pGeo, pMat);
        particle.position.set(x, y, z);

        particle.velocity = new THREE.Vector3(
            (Math.random() - 0.5) * 0.3,
            Math.random() * 0.3 + 0.1,
            (Math.random() - 0.5) * 0.3
        );
        particle.life = 30;
        scene.add(particle);
        particles.push(particle);
    }
}

function createDetailedTrainModel() {
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0xff3300, roughness: 0.2, metalness: 0.8 });
    const stripeMat = new THREE.MeshStandardMaterial({ color: 0xffea00, roughness: 0.3 });
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x111122, roughness: 0.1, metalness: 0.9 });
    const underMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });

    const mainBody = new THREE.Mesh(new THREE.BoxGeometry(2.0, 2.6, 12.0), bodyMat);
    mainBody.position.y = 1.4;
    mainBody.castShadow = true;
    group.add(mainBody);

    const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.06, 0.4, 12.02), stripeMat);
    stripe.position.y = 1.8;
    group.add(stripe);

    const windshield = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.9, 0.2), glassMat);
    windshield.position.set(0, 1.8, 6.01);
    group.add(windshield);

    const undercarriage = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.5, 11.5), underMat);
    undercarriage.position.y = 0.25;
    group.add(undercarriage);

    return group;
}

function spawnObstacleOrCoin(zPos) {
    const lane = Math.floor(Math.random() * LANES.length);
    const rand = Math.random();

    if (rand < 0.5) {
        const isTrain = Math.random() < 0.65;
        let obs;
        if (isTrain) {
            obs = createDetailedTrainModel();
            obs.position.set(LANES[lane], 0, zPos);
            obs.userData = { type: 'train', speedMod: Math.random() > 0.5 ? 1.2 : 0.8 };
        } else {
            const isHighBar = Math.random() < 0.4;
            const obsGeo = isHighBar ? new THREE.BoxGeometry(2.0, 0.4, 0.8) : new THREE.BoxGeometry(1.8, 1.4, 1.0);
            const obsMat = new THREE.MeshStandardMaterial({ color: 0xff0055, roughness: 0.1, metalness: 0.8 });
            obs = new THREE.Mesh(obsGeo, obsMat);
            obs.position.set(LANES[lane], isHighBar ? 1.8 : 0.7, zPos);
            obs.castShadow = true;
            obs.userData = { type: isHighBar ? 'highBar' : 'barrier', speedMod: 1.0 };
        }
        scene.add(obs);
        obstacles.push(obs);
    } else if (rand < 0.88) {
        const coinGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.1, 16);
        coinGeo.rotateX(Math.PI / 2);
        const coinMat = new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 0.9, roughness: 0.1, emissive: 0xffd700, emissiveIntensity: 0.4 });
        
        for (let c = 0; c < 5; c++) {
            const coin = new THREE.Mesh(coinGeo, coinMat);
            coin.position.set(LANES[lane], 1.0, zPos - c * 2);
            scene.add(coin);
            collectibleCoins.push(coin);
        }
    } else {
        const pGeo = new THREE.OctahedronGeometry(0.5);
        const pMat = new THREE.MeshStandardMaterial({ color: 0x00ffff, metalness: 0.9, roughness: 0.1, emissive: 0x00ffff, emissiveIntensity: 0.6 });
        const powerUp = new THREE.Mesh(pGeo, pMat);
        powerUp.position.set(LANES[lane], 1.2, zPos);
        powerUp.userData = { type: 'shield' };
        scene.add(powerUp);
        powerUps.push(powerUp);
    }
}

function startCountdown() {
    if (isCountingDown || gamePlaying) return;
    isCountingDown = true;
    document.getElementById('instructions').classList.add('hidden');
    
    const cdEl = document.getElementById('countdown');
    cdEl.classList.remove('hidden');
    
    let count = 3;
    cdEl.innerText = count;
    window.audioManager.playCountdown(false);

    const timer = setInterval(() => {
        count--;
        if (count > 0) {
            cdEl.innerText = count;
            window.audioManager.playCountdown(false);
        } else if (count === 0) {
            cdEl.innerText = 'GO!';
            window.audioManager.playCountdown(true);
        } else {
            clearInterval(timer);
            cdEl.classList.add('hidden');
            isCountingDown = false;
            resetGameState();
            gamePlaying = true;
        }
    }, 1000);
}

function restartGame() {
    document.getElementById('game-over').classList.add('hidden');
    if (inspector) inspector.visible = false;
    startCountdown();
}

function resetGameState() {
    score = 0;
    coins = 0;
    speed = 0.6;
    currentLane = 2;
    player.position.set(LANES[currentLane], 0, 0);
    if (inspector) {
        inspector.position.set(LANES[currentLane], 0, 15);
        inspector.visible = false;
    }
    playerState.isJumping = false;
    playerState.isDuck = false;
    playerState.yVelocity = 0;
    playerState.shieldActive = false;
    playerState.powerupTimer = 0;
    playerState.powerupType = null;

    obstacles.forEach(obs => scene.remove(obs));
    collectibleCoins.forEach(coin => scene.remove(coin));
    powerUps.forEach(p => scene.remove(p));
    particles.forEach(p => scene.remove(p));
    
    obstacles = [];
    collectibleCoins = [];
    powerUps = [];
    particles = [];

    for (let i = 1; i <= 10; i++) {
        spawnObstacleOrCoin(-18 * i);
    }

    updateHUD();
}

function triggerInspectorChase() {
    if (inspector && !inspector.visible) {
        inspector.visible = true;
        inspector.position.set(player.position.x, 0, player.position.z + 8);
    }
}

function gameOver() {
    gamePlaying = false;
    window.audioManager.playCrash();
    if (inspector) {
        inspector.visible = true;
        inspector.position.set(player.position.x, 0, player.position.z + 3);
    }
    document.getElementById('final-score').innerText = Math.floor(score);
    document.getElementById('final-coins').innerText = coins;
    document.getElementById('game-over').classList.remove('hidden');
    spawnParticles(player.position.x, player.position.y + 1, player.position.z, 0xff0055, 30);
}

function handleKeyDown(e) {
    if (!gamePlaying) return;

    if ((e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') && currentLane > 0) {
        currentLane--;
        spawnParticles(player.position.x, 0.5, 0, 0x00ffff, 6);
    } else if ((e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D') && currentLane < LANES.length - 1) {
        currentLane++;
        spawnParticles(player.position.x, 0.5, 0, 0x00ffff, 6);
    } else if ((e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W' || e.key === ' ') && !playerState.isJumping && !playerState.isDuck) {
        playerState.isJumping = true;
        playerState.yVelocity = playerState.jumpPower;
        window.audioManager.playJump();
        spawnParticles(player.position.x, 0.1, 0, 0xffffff, 8);
    } else if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
        if (!playerState.isJumping && !playerState.isDuck) {
            playerState.isDuck = true;
            player.scale.set(1, 0.4, 1);
            player.position.y = -0.3;
            setTimeout(() => {
                if (player && playerState.isDuck) {
                    player.scale.set(1, 1, 1);
                    player.position.y = 0;
                    playerState.isDuck = false;
                }
            }, 600);
        }
    }
}

function updateHUD() {
    document.getElementById('score').innerText = Math.floor(score);
    document.getElementById('coins').innerText = coins;

    const puStatus = document.getElementById('powerup-status');
    if (playerState.shieldActive) {
        puStatus.classList.remove('hidden');
        document.getElementById('powerup-name').innerText = 'SHIELD';
        document.getElementById('powerup-timer').innerText = Math.ceil(playerState.powerupTimer / 60);
    } else {
        puStatus.classList.add('hidden');
    }
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);

    if (gamePlaying) {
        score += speed * 0.25;
        speed += 0.00015;

        if (playerState.shieldActive) {
            playerState.powerupTimer--;
            if (playerState.powerupTimer <= 0) {
                playerState.shieldActive = false;
            }
        }

        updateHUD();

        if (playerState.isJumping) {
            player.position.y += playerState.yVelocity;
            playerState.yVelocity -= playerState.gravity;
            if (player.position.y <= 0) {
                player.position.y = 0;
                playerState.isJumping = false;
            }
        }

        const targetX = LANES[currentLane];
        player.position.x += (targetX - player.position.x) * 0.25;

        const runCycle = Date.now() * 0.015;
        if (player.userData.leftLeg && player.userData.rightLeg) {
            player.userData.leftLeg.rotation.x = Math.sin(runCycle) * 0.6;
            player.userData.rightLeg.rotation.x = -Math.sin(runCycle) * 0.6;
            player.userData.leftArm.rotation.x = -Math.sin(runCycle) * 0.5;
            player.userData.rightArm.rotation.x = Math.sin(runCycle) * 0.5;
        }

        if (inspector && inspector.visible) {
            inspector.position.x += (player.position.x - inspector.position.x) * 0.1;
            inspector.position.z += ( (player.position.z + 3.8) - inspector.position.z ) * 0.1;
        }

        trackSegments.forEach(track => {
            track.position.z += speed;
            if (track.position.z > 60) {
                track.position.z -= 180;
            }
        });

        clouds.forEach(cloud => {
            cloud.position.z += speed * 0.3;
            if (cloud.position.z > 60) {
                cloud.position.z -= 180;
            }
        });

        for (let i = obstacles.length - 1; i >= 0; i--) {
            const obs = obstacles[i];
            let moveSpeed = speed * (obs.userData.speedMod || 1.0);
            obs.position.z += moveSpeed;

            const playerBox = new THREE.Box3().setFromObject(player);
            const obsBox = new THREE.Box3().setFromObject(obs);

            if (playerBox.intersectsBox(obsBox)) {
                if (playerState.shieldActive) {
                    playerState.shieldActive = false;
                    window.audioManager.playCrash();
                    spawnParticles(obs.position.x, obs.position.y, obs.position.z, 0x00ffff, 25);
                    scene.remove(obs);
                    obstacles.splice(i, 1);
                    continue;
                } else {
                    triggerInspectorChase();
                    gameOver();
                }
            }

            if (obs.position.z > 12) {
                scene.remove(obs);
                obstacles.splice(i, 1);
                spawnObstacleOrCoin(-140);
            }
        }

        if (obstacles.length < 6) {
            spawnObstacleOrCoin(-140 - Math.random() * 25);
        }

        for (let i = collectibleCoins.length - 1; i >= 0; i--) {
            const coin = collectibleCoins[i];
            coin.position.z += speed;
            coin.rotation.y += 0.08;

            const playerBox = new THREE.Box3().setFromObject(player);
            const coinBox = new THREE.Box3().setFromObject(coin);

            if (playerBox.intersectsBox(coinBox)) {
                coins++;
                window.audioManager.playCoin();
                spawnParticles(coin.position.x, coin.position.y, coin.position.z, 0xffd700, 8);
                scene.remove(coin);
                collectibleCoins.splice(i, 1);
            } else if (coin.position.z > 12) {
                scene.remove(coin);
                collectibleCoins.splice(i, 1);
            }
        }

        if (collectibleCoins.length < 10) {
            spawnObstacleOrCoin(-120 - Math.random() * 30);
        }

        for (let i = powerUps.length - 1; i >= 0; i--) {
            const pUp = powerUps[i];
            pUp.position.z += speed;
            pUp.rotation.x += 0.04;
            pUp.rotation.y += 0.04;

            const playerBox = new THREE.Box3().setFromObject(player);
            const pBox = new THREE.Box3().setFromObject(pUp);

            if (playerBox.intersectsBox(pBox)) {
                playerState.shieldActive = true;
                playerState.powerupTimer = 300;
                window.audioManager.playShield();
                spawnParticles(pUp.position.x, pUp.position.y, pUp.position.z, 0x00ffff, 20);
                scene.remove(pUp);
                powerUps.splice(i, 1);
            } else if (pUp.position.z > 12) {
                scene.remove(pUp);
                powerUps.splice(i, 1);
            }
        }

        if (powerUps.length < 2 && Math.random() < 0.03) {
            spawnObstacleOrCoin(-160);
        }

        for (let i = particles.length - 1; i >= 0; i--) {
            const p = particles[i];
            p.position.add(p.velocity);
            p.life--;
            p.scale.multiplyScalar(0.95);
            if (p.life <= 0) {
                scene.remove(p);
                particles.splice(i, 1);
            }
        }
    }

    renderer.render(scene, camera);
}

window.onload = init;
