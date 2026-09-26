import * as THREE from 'three'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import normalCar1Obj from '../assets/cars/NormalCar1.obj?raw'
import normalCar2Obj from '../assets/cars/NormalCar2.obj?raw'
import sportsCarObj from '../assets/cars/SportsCar.obj?raw'
import suvObj from '../assets/cars/SUV.obj?raw'
import taxiObj from '../assets/cars/Taxi.obj?raw'
import type { SceneData } from '../types/scene'

type VehicleModelKey = 'normalA' | 'normalB' | 'sports' | 'suv' | 'taxi'

const loader = new OBJLoader()

const vehicleGeometries: Record<VehicleModelKey, THREE.BufferGeometry> = {
  normalA: createNormalizedGeometry(normalCar1Obj),
  normalB: createNormalizedGeometry(normalCar2Obj),
  sports: createNormalizedGeometry(sportsCarObj),
  suv: createNormalizedGeometry(suvObj),
  taxi: createNormalizedGeometry(taxiObj),
}

export function makeVehicleGeometry(agent: SceneData['agents'][number], height: number) {
  const geometry = vehicleGeometries[getVehicleModelKey(agent)].clone()
  geometry.scale(agent.length, agent.width, height)
  return geometry
}

function getVehicleModelKey(agent: SceneData['agents'][number]): VehicleModelKey {
  if (agent.is_sdc) return 'suv'
  if (agent.width >= 2.05 || agent.length >= 4.9) return 'suv'
  if (agent.length <= 3.8) return 'sports'
  if (agent.id % 7 === 0) return 'taxi'
  return agent.id % 2 === 0 ? 'normalA' : 'normalB'
}

function createNormalizedGeometry(objText: string) {
  const object = loader.parse(objText)
  object.updateMatrixWorld(true)

  const positions: number[] = []
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh) || !(child.geometry instanceof THREE.BufferGeometry)) return

    const source = child.geometry
    const position = source.getAttribute('position')
    if (!position) return

    const vertex = new THREE.Vector3()
    const addVertex = (index: number) => {
      vertex.fromBufferAttribute(position, index).applyMatrix4(child.matrixWorld)
      positions.push(vertex.z, vertex.x, vertex.y)
    }

    if (source.index) {
      for (let index = 0; index < source.index.count; index += 1) {
        addVertex(source.index.getX(index))
      }
    } else {
      for (let index = 0; index < position.count; index += 1) {
        addVertex(index)
      }
    }
  })

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  normalizeGeometryBounds(geometry)
  smoothSharedVertexNormals(geometry)
  return geometry
}

function normalizeGeometryBounds(geometry: THREE.BufferGeometry) {
  geometry.computeBoundingBox()
  const box = geometry.boundingBox
  if (!box) return

  const size = new THREE.Vector3()
  const center = new THREE.Vector3()
  box.getSize(size)
  box.getCenter(center)

  const position = geometry.getAttribute('position')
  for (let index = 0; index < position.count; index += 1) {
    position.setXYZ(
      index,
      (position.getX(index) - center.x) / Math.max(size.x, 0.001),
      (position.getY(index) - center.y) / Math.max(size.y, 0.001),
      (position.getZ(index) - center.z) / Math.max(size.z, 0.001),
    )
  }
  position.needsUpdate = true
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
}

function smoothSharedVertexNormals(geometry: THREE.BufferGeometry) {
  const position = geometry.getAttribute('position')
  const normalSums = new Map<string, THREE.Vector3>()
  const triangleNormal = new THREE.Vector3()
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const cb = new THREE.Vector3()
  const ab = new THREE.Vector3()

  for (let index = 0; index < position.count; index += 3) {
    a.fromBufferAttribute(position, index)
    b.fromBufferAttribute(position, index + 1)
    c.fromBufferAttribute(position, index + 2)
    cb.subVectors(c, b)
    ab.subVectors(a, b)
    triangleNormal.crossVectors(cb, ab)
    if (triangleNormal.lengthSq() > 0) triangleNormal.normalize()

    for (let vertexIndex = index; vertexIndex < index + 3; vertexIndex += 1) {
      const key = getVertexKey(position, vertexIndex)
      const normal = normalSums.get(key) ?? new THREE.Vector3()
      normal.add(triangleNormal)
      normalSums.set(key, normal)
    }
  }

  normalSums.forEach((normal) => {
    if (normal.lengthSq() > 0) normal.normalize()
  })

  const normals = new Float32Array(position.count * 3)
  for (let index = 0; index < position.count; index += 1) {
    const normal = normalSums.get(getVertexKey(position, index)) ?? new THREE.Vector3(0, 0, 1)
    normals[index * 3] = normal.x
    normals[index * 3 + 1] = normal.y
    normals[index * 3 + 2] = normal.z
  }
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
}

function getVertexKey(position: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, index: number) {
  return `${position.getX(index).toFixed(4)}|${position.getY(index).toFixed(4)}|${position.getZ(index).toFixed(4)}`
}
