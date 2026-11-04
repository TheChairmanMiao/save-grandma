import { useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Euler, Group, Quaternion } from 'three';
import type { ItemId } from '../game/types';
import type { SceneFrame } from '../view/presentation';
import { radians } from '../game/config';

/**
 * Cartoon Grandma for the phone's front camera: big round head, oversized glasses, rosy cheeks.
 * Local origin at the feet, facing +Z; the scene applies position and yaw. Idle motion
 * (breathing, head sway, blinking, a chatty mouth) is cosmetic and never touches gameplay.
 */
const SKIN = '#f6cfae', HAIR = '#e9e6df', CARDIGAN = '#8e7cc3', SKIRT = '#5b6fb5', SHOE = '#4a3f55', OUTLINE = '#3b2a4a';
type V3 = [number, number, number];

function Ball({ position, scale, color, rough = 0.8 }: { position: V3; scale: V3 | number; color: string; rough?: number }) {
  const s: V3 = typeof scale === 'number' ? [scale, scale, scale] : scale;
  return <mesh position={position} scale={s} castShadow><sphereGeometry args={[1, 20, 14]} /><meshStandardMaterial color={color} roughness={rough} /></mesh>;
}
function Block({ position, size, color, rotation }: { position: V3; size: V3; color: string; rotation?: V3 }) {
  return <mesh position={position} rotation={rotation} castShadow><boxGeometry args={size} /><meshStandardMaterial color={color} roughness={0.85} /></mesh>;
}

function HeldItem({ id }: { id: ItemId }) {
  switch (id as string) {
    case 'wrench': return <group rotation={[Math.PI / 2, 0, 0]}><Block position={[0, 0, 0]} size={[0.06, 0.3, 0.04]} color="#9aa7aa" /><Block position={[0.06, 0.16, 0]} size={[0.08, 0.12, 0.05]} color="#9aa7aa" /><Block position={[-0.06, 0.16, 0]} size={[0.08, 0.12, 0.05]} color="#9aa7aa" /></group>;
    case 'screwdriver': return <group rotation={[Math.PI / 2, 0, 0]}><Block position={[0, 0.07, 0]} size={[0.035, 0.14, 0.035]} color="#e8b64a" /><Block position={[0, -0.07, 0]} size={[0.012, 0.16, 0.012]} color="#9aa7aa" /></group>;
    case 'hammer': return <group rotation={[Math.PI / 2, 0, 0]}><Block position={[0, 0, 0]} size={[0.03, 0.3, 0.03]} color="#a97845" /><Block position={[0, 0.15, 0]} size={[0.14, 0.06, 0.06]} color="#6b6f73" /></group>;
    case 'towels': return <group>{[0, 1, 2].map(i => <Block key={i} position={[0, i * 0.055, 0]} size={[0.4, 0.055, 0.26]} color={i % 2 ? '#f1d5b9' : '#db967c'} />)}</group>;
    case 'bucket': return <mesh><cylinderGeometry args={[0.2, 0.15, 0.34, 16]} /><meshStandardMaterial color="#73a9bc" /></mesh>;
  }
}

export default function Grandma({ frame }: { frame: SceneFrame }) {
  const torso = useRef<Group>(null);
  const head = useRef<Group>(null);
  const eyes = useRef<Group>(null);
  const mouth = useRef<Group>(null);
  const leftLeg = useRef<Group>(null);
  const rightLeg = useRef<Group>(null);
  const gaze = useRef(new Euler(0, 0, 0, 'YXZ'));
  const upright = useRef(new Quaternion());
  const aimed = useRef(new Quaternion());
  const { hands } = frame.character;

  useFrame(() => {
    const { bend, animation, motion, look } = frame.character;
    const t = motion.reducedMotion ? 0 : frame.time;
    const breath = motion.reducedMotion ? 0 : (Math.sin(t * 1.7) + 1) / 2;
    if (torso.current) {
      torso.current.scale.set(1 + breath * 0.012, 1 + breath * 0.03, 1 + breath * 0.012);
      torso.current.rotation.x = bend * 0.75;
      torso.current.rotation.z = Math.sin(t * 0.6) * 0.02;
      torso.current.position.y = -bend * 0.2;
    }
    if (head.current) {
      gaze.current.set(-radians(look.pitch) + Math.sin(t * 1.1) * 0.03, radians(look.yaw) + Math.sin(t * 0.45) * 0.09, Math.sin(t * 0.8) * 0.05, 'YXZ');
      // Cancel the parent torso tilt before applying the shared eye direction.
      upright.current.identity();
      if (torso.current) upright.current.copy(torso.current.quaternion).invert();
      aimed.current.setFromEuler(gaze.current);
      head.current.quaternion.copy(upright.current).multiply(aimed.current);
      head.current.position.y = 1.42 + breath * 0.012;
    }
    if (eyes.current) {
      const cycle = t % 3.4;
      eyes.current.scale.y = cycle > 3.22 ? 0.12 : 1;
      eyes.current.position.x = Math.sin(t * 0.5) * 0.012;
    }
    if (mouth.current) {
      const talking = animation.name !== 'Idle_Standing' && animation.name !== 'Idle_Bent' ? 0.4 : 0.18;
      mouth.current.scale.y = 1 + Math.max(0, Math.sin(t * 7.3) * Math.sin(t * 2.1)) * talking;
    }
    const walk = Math.sin(motion.phase) * motion.weight * 0.4;
    if (leftLeg.current) leftLeg.current.rotation.x = walk;
    if (rightLeg.current) rightLeg.current.rotation.x = -walk;
  });

  return <group>
    {/* Legs and shoes */}
    <group ref={leftLeg} position={[-0.11, 0.45, 0]}><Block position={[0, -0.2, 0]} size={[0.13, 0.44, 0.14]} color="#d9c7bd" /><Block position={[0, -0.42, 0.05]} size={[0.16, 0.08, 0.27]} color={SHOE} /></group>
    <group ref={rightLeg} position={[0.11, 0.45, 0]}><Block position={[0, -0.2, 0]} size={[0.13, 0.44, 0.14]} color="#d9c7bd" /><Block position={[0, -0.42, 0.05]} size={[0.16, 0.08, 0.27]} color={SHOE} /></group>
    <group ref={torso} position={[0, 0, 0]}>
      <mesh position={[0, 0.62, 0]} castShadow><cylinderGeometry args={[0.24, 0.36, 0.5, 14]} /><meshStandardMaterial color={SKIRT} roughness={0.9} /></mesh>
      <mesh position={[0, 1.0, 0]} castShadow><cylinderGeometry args={[0.22, 0.27, 0.42, 14]} /><meshStandardMaterial color={CARDIGAN} roughness={0.9} /></mesh>
      <Ball position={[0, 1.2, 0]} scale={[0.25, 0.1, 0.22]} color={CARDIGAN} />
      {[-0.08, 0.08].map(x => <Ball key={x} position={[x, 1.02, 0.22]} scale={[0.028, 0.028, 0.012]} color="#ffd23f" rough={0.3} />)}
      {/* Arms */}
      <Block position={[-0.31, 0.98, 0.08]} size={[0.11, 0.42, 0.11]} color={CARDIGAN} rotation={[-0.5, 0, 0.1]} />
      <Block position={[0.31, 0.98, 0.08]} size={[0.11, 0.42, 0.11]} color={CARDIGAN} rotation={[-0.5, 0, -0.1]} />
      <group name="hand_right" position={[-0.33, 0.8, 0.26]}><Ball position={[0, 0, 0]} scale={0.075} color={SKIN} />{hands.right && <group position={[0, 0.02, 0.06]}><HeldItem id={hands.right} /></group>}</group>
      <group name="hand_left" position={[0.33, 0.8, 0.26]}><Ball position={[0, 0, 0]} scale={0.075} color={SKIN} />{hands.left && hands.left !== 'phone' && <group position={[0, 0.02, 0.06]}><HeldItem id={hands.left} /></group>}</group>
      {/* Head */}
      <group ref={head} name="head" position={[0, 1.42, 0]}><group scale={0.72}>
        <Ball position={[0, 0, 0]} scale={[0.23, 0.24, 0.22]} color={SKIN} rough={0.7} />
        <Ball position={[0, 0.1, -0.03]} scale={[0.245, 0.2, 0.235]} color={HAIR} />
        <Ball position={[0, 0.27, -0.1]} scale={0.12} color={HAIR} />
        {[-0.24, 0.24].map(x => <Ball key={x} position={[x, -0.02, 0]} scale={[0.04, 0.05, 0.03]} color={SKIN} />)}
        {/* Eyebrows, eyes and oversized glasses */}
        {[-0.085, 0.085].map(x => <Block key={x} position={[x, 0.13, 0.2]} size={[0.07, 0.014, 0.012]} color="#8a7a6a" rotation={[0, 0, x > 0 ? -0.15 : 0.15]} />)}
        <group ref={eyes}>
          {[-0.085, 0.085].map(x => <group key={x}>
            <Ball position={[x, 0.05, 0.2]} scale={[0.05, 0.05, 0.03]} color="#ffffff" rough={0.3} />
            <Ball position={[x + (x > 0 ? -0.004 : 0.004), 0.05, 0.228]} scale={[0.022, 0.024, 0.012]} color={OUTLINE} rough={0.3} />
            <Ball position={[x + 0.01, 0.062, 0.238]} scale={0.006} color="#ffffff" rough={0.1} />
          </group>)}
        </group>
        {[-0.085, 0.085].map(x => <mesh key={x} position={[x, 0.05, 0.215]}><torusGeometry args={[0.07, 0.009, 8, 24]} /><meshStandardMaterial color="#c9553f" roughness={0.4} /></mesh>)}
        <Block position={[0, 0.05, 0.218]} size={[0.035, 0.01, 0.01]} color="#c9553f" />
        {/* Cheeks, nose and mouth */}
        {[-0.14, 0.14].map(x => <Ball key={x} position={[x, -0.03, 0.16]} scale={[0.045, 0.03, 0.02]} color="#f2a2a0" />)}
        <Ball position={[0, -0.01, 0.235]} scale={[0.035, 0.03, 0.03]} color="#e8ad8c" />
        <group ref={mouth} position={[0, -0.1, 0.2]}>
          <Ball position={[0, 0, 0]} scale={[0.055, 0.022, 0.015]} color="#8c3b4a" rough={0.5} />
        </group>
      </group></group>
    </group>
  </group>;
}
