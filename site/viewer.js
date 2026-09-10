import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function overviewCamera(frame) {
  const span=Math.max(...frame.max.map((n,i)=>n-frame.min[i]));
  return {id:'overview',origin:frame.min.map((v,i)=>(v+frame.max[i])/2),
    right:[Math.SQRT1_2,0,-Math.SQRT1_2],up:[-1/Math.sqrt(6),2/Math.sqrt(6),-1/Math.sqrt(6)],
    extent:[-span*.78,span*.78,-span*.63,span*.63],depth_range:[-span,span]};
}
export async function createViewers(items,frame,options={}) {
  const viewers=[],center=new THREE.Vector3(...frame.min).add(new THREE.Vector3(...frame.max)).multiplyScalar(.5);
  const span=Math.max(...frame.max.map((n,i)=>n-frame.min[i])),local=Boolean(options.view);
  let syncing=false,disposed=false,preset=options.view||overviewCamera(frame),style=options.style||'gray';
  function renderAll(){for(const v of viewers)v.renderer.render(v.scene,v.camera);}
  function frustum(v) {
    if(!local)return;
    const [l,r,b,t]=preset.extent,aspect=Math.max(1,v.element.clientWidth)/Math.max(1,v.element.clientHeight);
    const h=Math.max(t-b,(r-l)/aspect);
    v.camera.left=-h*aspect/2;v.camera.right=h*aspect/2;v.camera.top=h/2;v.camera.bottom=-h/2;
    v.camera.updateProjectionMatrix();
  }
  function applyView(v) {
    const right=new THREE.Vector3(...preset.right),up=new THREE.Vector3(...preset.up),forward=right.clone().cross(up);
    const [l,r,b,t]=preset.extent;
    const target=new THREE.Vector3(...preset.origin).addScaledVector(right,(l+r)/2).addScaledVector(up,(b+t)/2);
    v.camera.up.copy(up);v.camera.position.copy(target).addScaledVector(forward,span*3);v.camera.zoom=1;
    v.controls.target.copy(target);v.camera.lookAt(target);frustum(v);v.controls.update();v.controls.saveState();
    v.depth.uniforms.origin.value.set(...preset.origin);v.depth.uniforms.direction.value.copy(forward);
    v.depth.uniforms.range.value.set(...preset.depth_range);
  }
  function applyStyle(v) {
    for(const mesh of v.meshes)mesh.material=style==='material'?mesh.userData.originalMaterial:
      style==='normal'?v.normal:style==='depth'?v.depth:v.material;
    if(v.grid)v.grid.visible=!local&&style!=='normal'&&style!=='depth';
  }
  function dispose() {
    disposed=true;
    for(const v of viewers){
      v.controls.dispose();v.observer?.disconnect();
      const materials=new Set([v.material,v.normal,v.depth]);
      v.scene.traverse(node=>{
        node.geometry?.dispose();
        if(node.userData.originalMaterial)for(const m of Array.isArray(node.userData.originalMaterial)?node.userData.originalMaterial:[node.userData.originalMaterial])materials.add(m);
      });
      materials.forEach(m=>m.dispose());v.renderer.dispose();v.renderer.forceContextLoss();v.renderer.domElement.remove();
    }
  }
  try {
    for(const item of items) {
      const element=document.getElementById(item.element);element.replaceChildren();
      const renderer=new THREE.WebGLRenderer({antialias:true});
      renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));renderer.outputColorSpace=THREE.SRGBColorSpace;
      renderer.setClearColor(0x101c2b);renderer.toneMapping=THREE.ACESFilmicToneMapping;
      renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
      element.append(renderer.domElement);
      renderer.domElement.setAttribute('aria-label',item.label+'，拖动旋转，滚轮缩放');renderer.domElement.setAttribute('role','img');
      const scene=new THREE.Scene(),camera=local?new THREE.OrthographicCamera(-1,1,1,-1,.01,span*10):
        new THREE.PerspectiveCamera(35,1,.1,span*30);
      const controls=new OrbitControls(camera,renderer.domElement);
      controls.enableDamping=false;controls.minDistance=span*.15;controls.maxDistance=span*10;controls.minZoom=.2;controls.maxZoom=12;
      const material=new THREE.MeshStandardMaterial({color:0xa1b3c4,roughness:.85,metalness:0,flatShading:true});
      const normal=new THREE.MeshNormalMaterial({flatShading:true,toneMapped:false});
      const depth=new THREE.ShaderMaterial({
        uniforms:{origin:{value:new THREE.Vector3(...preset.origin)},direction:{value:new THREE.Vector3(...preset.right).cross(new THREE.Vector3(...preset.up))},
          range:{value:new THREE.Vector2(...preset.depth_range)}},
        vertexShader:'varying vec3 worldPoint; void main(){vec4 world=modelMatrix*vec4(position,1.0);worldPoint=world.xyz;gl_Position=projectionMatrix*viewMatrix*world;}',
        fragmentShader:'uniform vec3 origin; uniform vec3 direction; uniform vec2 range; varying vec3 worldPoint; void main(){float d=dot(worldPoint-origin,direction);float t=clamp((d-range.x)/(range.y-range.x),0.0,1.0);gl_FragColor=vec4(mix(vec3(0.08,0.13,0.18),vec3(0.80,0.95,1.0),t),1.0);}',
        toneMapped:false
      });
      scene.add(new THREE.HemisphereLight(0xd6edff,0x374051,1.5));
      const key=new THREE.DirectionalLight(0xffffff,3);key.position.set(span,span*2,span*1.2);
      key.target.position.copy(center);scene.add(key,key.target);key.castShadow=true;
      key.shadow.mapSize.set(2048,2048);
      Object.assign(key.shadow.camera,{left:-span,right:span,top:span,bottom:-span,near:.1,far:span*8});
      key.shadow.bias=-.00015;key.shadow.normalBias=.008;
      const fill=new THREE.DirectionalLight(0x98c2ed,.5);fill.position.set(-span,span,-span);scene.add(fill);
      const grid=new THREE.GridHelper(span*2,20,0x2f5362,0x223441);grid.position.set(center.x,frame.min[1]-.04,center.z);scene.add(grid);
      const v={renderer,scene,camera,controls,material,normal,depth,grid,element,observer:null,meshes:[]};viewers.push(v);
      const resize=()=>{
        const width=element.clientWidth,height=element.clientHeight;if(width<1||height<1)return;
        renderer.setSize(width,height,false);if(local)frustum(v);else{camera.aspect=width/height;camera.updateProjectionMatrix();}
        renderer.render(scene,camera);
      };
      v.observer=new ResizeObserver(resize);v.observer.observe(element);
      if(local)applyView(v);else {
        camera.position.copy(center).add(new THREE.Vector3(1,.72,1.25).multiplyScalar(span*1.5));
        controls.target.copy(center);camera.lookAt(center);controls.update();controls.saveState();
      }
      controls.addEventListener('change',()=>{
        if(syncing||disposed)return;syncing=true;
        for(const other of viewers)if(other!==v) {
          other.camera.position.copy(camera.position);other.camera.quaternion.copy(camera.quaternion);
          other.camera.up.copy(camera.up);other.camera.zoom=camera.zoom;other.camera.updateProjectionMatrix();
          other.controls.target.copy(controls.target);other.controls.update();
        }
        renderAll();syncing=false;
      });
      resize();
    }
    await Promise.all(items.map(async(item,i)=>{
      const gltf=await new GLTFLoader().loadAsync(item.url);
      if(disposed){gltf.scene.traverse(n=>n.geometry?.dispose());return;}
      gltf.scene.traverse(node=>{
        if(node.isMesh){
          node.geometry.computeVertexNormals();node.geometry.computeBoundingBox();node.geometry.computeBoundingSphere();
          node.userData.originalMaterial=node.material;node.castShadow=true;node.receiveShadow=true;
          viewers[i].meshes.push(node);
        }
      });
      viewers[i].scene.add(gltf.scene);applyStyle(viewers[i]);
    }));
    renderAll();
    return {
      setStyle(next){if(!['gray','material','normal','depth'].includes(next))throw new Error('Unknown view style');style=next;viewers.forEach(applyStyle);renderAll();},
      setView(next){if(!local)throw new Error('Local camera presets require an orthographic viewer');preset=next;syncing=true;viewers.forEach(applyView);syncing=false;renderAll();},
      reset(){if(viewers[0])viewers[0].controls.reset();},dispose
    };
  }catch(error){dispose();throw error;}
}
