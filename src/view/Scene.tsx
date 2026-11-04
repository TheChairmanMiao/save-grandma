import { Component, useEffect, useRef, useState, type ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Group, PerspectiveCamera } from 'three';
import { SCENE_VISUALS } from '../creative/visuals';
import { getSceneFrame, stepSceneMotion, type SceneFrame, type SceneMotion } from './presentation';
import { radians, TUNING } from '../game/config';
import type { WorldState } from '../game/controller';
import type { ItemId } from '../game/types';

const colors = { wall: '#d8e3d8', tile: '#f0eee2', peach: '#db967c', metal: '#87979a', brass: '#b69055', dress: '#84978b' };
function Box({ position, size, color, rotation }: { position: [number, number, number]; size: [number, number, number]; color: string; rotation?: [number, number, number] }) {
  return <mesh position={position} rotation={rotation} castShadow receiveShadow><boxGeometry args={size} /><meshStandardMaterial color={color} roughness={0.8} /></mesh>;
}
function Sphere({ position, size, color }: { position: [number, number, number]; size: [number, number, number]; color: string }) {
  return <mesh position={position} scale={size} castShadow><sphereGeometry args={[1, 16, 12]} /><meshStandardMaterial color={color} roughness={0.85} /></mesh>;
}
function Tool({ id }: { id: ItemId }) {
  if (SCENE_VISUALS.Tool) return <SCENE_VISUALS.Tool id={id} />;
  switch (id) {
    case 'wrench': return <group rotation={[Math.PI / 2, 0, 0]}><Box position={[0, 0, 0]} size={[0.06, 0.32, 0.04]} color={colors.metal} /><Box position={[0.06, 0.17, 0]} size={[0.08, 0.13, 0.05]} color={colors.metal} /><Box position={[-0.06, 0.17, 0]} size={[0.08, 0.13, 0.05]} color={colors.metal} /></group>;
    case 'screwdriver': return <group rotation={[Math.PI / 2, 0, 0]}><Box position={[0, 0.07, 0]} size={[0.035, 0.14, 0.035]} color="#e8b64a" /><Box position={[0, -0.07, 0]} size={[0.012, 0.16, 0.012]} color="#9aa7aa" /></group>;
    case 'hammer': return <group rotation={[Math.PI / 2, 0, 0]}><Box position={[0, 0, 0]} size={[0.03, 0.3, 0.03]} color="#a97845" /><Box position={[0, 0.15, 0]} size={[0.14, 0.06, 0.06]} color="#6b6f73" /></group>;
    case 'towels': return <group>{[0, 1, 2].map(i => <Box key={i} position={[0, i * 0.055, 0]} size={[0.44, 0.055, 0.28]} color={i % 2 ? '#f1d5b9' : colors.peach} />)}</group>;
    case 'bucket': return <group><mesh position={[0, 0.02, 0]}><cylinderGeometry args={[0.23, 0.17, 0.38, 16, 1, true]} /><meshStandardMaterial color="#73a9bc" side={2} /></mesh><mesh position={[0, -0.15, 0]}><cylinderGeometry args={[0.17, 0.17, 0.025, 16]} /><meshStandardMaterial color="#73a9bc" /></mesh></group>;
  }
}

function Grandma({ world, frame }: { world: WorldState; frame: SceneFrame }) {
  const model = useRef<Group>(null);
  const leftLeg = useRef<Group>(null);
  const rightLeg = useRef<Group>(null);
  useFrame(() => {
    const walk = Math.sin(frame.character.motion.phase) * frame.character.motion.weight * 0.2;
    if (leftLeg.current) leftLeg.current.rotation.x = walk;
    if (rightLeg.current) rightLeg.current.rotation.x = -walk;
    if (model.current) {
      const bend = frame.character.bend;
      model.current.rotation.x = bend * 0.65;
      model.current.position.y = -bend * 0.22;
    }
  });
  return <group>
    <group ref={leftLeg} position={[-0.12, 0.43, 0]}><Box position={[0, -0.2, 0]} size={[0.13, 0.42, 0.14]} color="#647069" /><Box position={[0, -0.4, 0.04]} size={[0.16, 0.09, 0.25]} color="#4a524b" /></group>
    <group ref={rightLeg} position={[0.12, 0.43, 0]}><Box position={[0, -0.2, 0]} size={[0.13, 0.42, 0.14]} color="#647069" /><Box position={[0, -0.4, 0.04]} size={[0.16, 0.09, 0.25]} color="#4a524b" /></group>
    <group ref={model}>
      <mesh position={[0, 0.77, 0]} castShadow><cylinderGeometry args={[0.19, 0.31, 0.72, 10]} /><meshStandardMaterial color={colors.dress} /></mesh>
      <Sphere position={[0, 1.34, 0]} size={[0.245, 0.27, 0.22]} color="#e4b69a" />
      <Sphere position={[0, 1.52, -0.03]} size={[0.25, 0.14, 0.22]} color="#e7e5dc" />
      <Sphere position={[0, 1.54, -0.18]} size={[0.12, 0.12, 0.12]} color="#e7e5dc" />
      {[-0.095, 0.095].map(x => <group key={x}><mesh position={[x, 1.38, 0.204]}><torusGeometry args={[0.07, 0.009, 6, 20]} /><meshStandardMaterial color="#5e5146" /></mesh><Sphere position={[x, 1.385, 0.215]} size={[0.018, 0.021, 0.012]} color="#40413a" /></group>)}
      <Box position={[0, 1.38, 0.213]} size={[0.065, 0.01, 0.01]} color="#5e5146" />
      <Sphere position={[0, 1.32, 0.228]} size={[0.035, 0.035, 0.04]} color="#d09c7e" />
      <Box position={[0, 1.24, 0.207]} size={[0.07, 0.012, 0.01]} color="#9d6358" />
      <group name="hand_left" position={[0.28, 1.05, 0.17]}><Sphere position={[0, 0, 0]} size={[0.075, 0.09, 0.075]} color="#e4b69a" /></group>
      <group name="hand_right" position={[-0.29, 0.94, 0.17]}><Sphere position={[0, 0, 0]} size={[0.075, 0.09, 0.075]} color="#e4b69a" />{world.grandma.held[0] && <Tool id={world.grandma.held[0]} />}</group>
      {world.grandma.held[1] && <group position={[0.3, 1.05, 0.18]}><Tool id={world.grandma.held[1]} /></group>}
    </group>
  </group>;
}

function CharacterAndCamera({ world, frame, reducedMotion }: { world: WorldState; frame: SceneFrame; reducedMotion: boolean }) {
  const root = useRef<Group>(null);
  const motion = useRef<SceneMotion | null>(null);
  // This render-only contract is shared by the procedural model and the lens.
  const shown: SceneFrame = { ...frame, character: { ...frame.character } };
  useFrame(({ camera }, delta) => {
    const next = stepSceneMotion(motion.current, frame, delta, reducedMotion);
    motion.current = next;
    shown.time = next.time;
    shown.character.bend = next.character.bend;
    shown.character.look = next.character.look;
    shown.character.motion = { ...next.gait, reducedMotion };
    if (root.current) {
      root.current.position.set(...next.character.position);
      root.current.rotation.y = radians(next.character.yaw);
    }
    camera.position.set(...next.phone.position);
    // Yaw/pitch describe the physical lens. No look-at target can recenter it mid-step.
    camera.rotation.set(radians(next.phone.pitch), radians(next.phone.yaw) + Math.PI, radians(next.phone.roll), 'YXZ');
    if (camera instanceof PerspectiveCamera && camera.fov !== next.phone.verticalFov) {
      camera.fov = next.phone.verticalFov;
      camera.updateProjectionMatrix();
    }
  }, -1);
  return <group ref={root} name="grandma_root" position={frame.character.position} rotation={[0, radians(frame.character.yaw), 0]}>
    {SCENE_VISUALS.Grandma ? <SCENE_VISUALS.Grandma frame={shown} /> : <Grandma world={world} frame={shown} />}
  </group>;
}

function Bathroom({ world, reducedMotion }: { world: WorldState; reducedMotion: boolean }) {
  const frame = getSceneFrame(world);
  return <>
    <color attach="background" args={['#d8e3d8']} />
    <ambientLight intensity={1.4} />
    <directionalLight position={[0, 5, 1]} intensity={2.2} castShadow shadow-mapSize={[1024, 1024]} />
    {SCENE_VISUALS.Environment ? <SCENE_VISUALS.Environment frame={frame} /> : <>
    <Box position={[0, -0.075, 2.75]} size={[6, 0.15, 6.5]} color={colors.tile} />
    <gridHelper args={[6, 12, '#bcc8be', '#cbd2c8']} position={[0, 0.007, 2.75]} />
    <Box position={[0, 1.7, 5.4]} size={[6, 3.4, 0.15]} color={colors.wall} />
    <Box position={[-3, 1.7, 2.5]} size={[0.15, 3.4, 6]} color={colors.wall} />
    <Box position={[3, 1.7, 2.5]} size={[0.15, 3.4, 6]} color={colors.wall} />
    <Box position={[0, 1.7, -0.4]} size={[6, 3.4, 0.15]} color="#d2dbcd" />
    <Box position={[0.7, 1.1, -0.3]} size={[1.2, 2.2, 0.07]} color="#b4c0ae" />
    <Sphere position={[0.23, 1.05, -0.22]} size={[0.05, 0.05, 0.05]} color={colors.brass} />
    <Box position={[-0.9, 2.0, 5.28]} size={[1.7, 1.2, 0.04]} color="#95afa8" />
    <Box position={[-0.9, 1.13, 4.94]} size={[1.8, 0.2, 0.65]} color="#fcf7e9" />
    <Box position={[-0.9, 1.26, 5]} size={[1.15, 0.08, 0.5]} color="#c4d0c7" />
    <Box position={[-0.9, 1.36, 5.12]} size={[0.09, 0.35, 0.1]} color={colors.metal} />
    <Box position={[-0.95, 0.48, 4.69]} size={[1.22, 0.09, 0.09]} color="#b65041" />
    <Box position={[-0.3, 0.72, 4.69]} size={[0.09, 0.5, 0.09]} color="#b65041" />
    <Box position={[-1.3, 0.48, 4.69]} size={[0.18, 0.17, 0.16]} color="#8f3426" />
    {world.leakRate > 0 && <mesh position={[-1.3, 0.24, 4.64]}><cylinderGeometry args={[0.012, 0.08 * world.leakRate / TUNING.initialLeakPerSecond, 0.48, 8]} /><meshStandardMaterial color="#8ac9d6" transparent opacity={0.7} /></mesh>}
    <Box position={[0.22, 0.75, 2.5]} size={[1.95, 0.08, 0.55]} color="#b2bda8" />
    {[-0.58, 1].map(x => <Box key={x} position={[x, 0.37, 2.5]} size={[0.08, 0.75, 0.38]} color="#a7b29e" />)}
    <Box position={[-2.15, 0.73, 1.65]} size={[0.65, 0.12, 0.48]} color="#b2bda8" />
    <Box position={[1.8, 1.08, 3.5]} size={[0.6, 0.13, 0.55]} color="#749584" />
    <Box position={[1.8, 0.53, 3.5]} size={[0.13, 1.06, 0.13]} color="#9caa93" />
    {world.phone.placement === 'dry_spot' && <Box position={[1.8, 1.29, 3.5]} size={[0.09, 0.18, 0.018]} color="#2b3935" />}
    <Box position={[2.2, 0.8, 5.02]} size={[0.65, 0.8, 0.3]} color="#eeeede" />
    <Sphere position={[2.2, 0.47, 4.68]} size={[0.37, 0.24, 0.5]} color="#f4f3e7" />
    <Box position={[2.2, 0.22, 4.75]} size={[0.42, 0.44, 0.5]} color="#e8e9dc" />
    </>}
    {Object.entries(world.items).filter(([, item]) => item.location === 'world').map(([id, item]) => <group key={id} name={id} position={[item.position.x, item.height + 0.025, item.position.z]}><Tool id={id as ItemId} /></group>)}
    {world.towelUsed && <group position={[-1.55, 0.04, 4]}><Tool id="towels" /></group>}
    {world.bucketUsed && <group position={[-1.3, 0.2, 4.55]}><Tool id="bucket" /></group>}
    {world.water > 0 && <mesh position={[0, 0.015 + world.water / TUNING.floodThreshold * 0.3, 2.75]} rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[5.95, 6.4]} /><meshStandardMaterial color="#5ea8be" transparent opacity={0.22 + world.water / 250} roughness={0.2} depthWrite={false} /></mesh>}
    <CharacterAndCamera world={world} frame={frame} reducedMotion={reducedMotion} />
  </>;
}
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <div className="scene-fallback">The 3D camera needs WebGL. Enable hardware acceleration and reload. The simulation and developer controls are still available.</div> : this.props.children; }
}
export default function Scene({ world }: { world: WorldState }) {
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReducedMotion(preference.matches);
    preference.addEventListener('change', update);
    update();
    return () => preference.removeEventListener('change', update);
  }, []);
  return <SceneBoundary><Canvas shadows dpr={[1, 1.5]} camera={{ fov: 88, near: 0.035, far: 30 }} gl={{ antialias: true }} fallback={<div className="scene-fallback">WebGL unavailable. The simulation remains available in the developer panel.</div>}><Bathroom world={world} reducedMotion={reducedMotion} /></Canvas></SceneBoundary>;
}
