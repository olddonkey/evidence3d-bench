import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export async function createViewers(items, frame) {
  const viewers=[], center=new THREE.Vector3(...frame.min).add(new THREE.Vector3(...frame.max)).multiplyScalar(0.5);
  const span=Math.max(...frame.max.map((n,i)=>n-frame.min[i]));
  let syncing=false,disposed=false;
  try {
    for(const item of items) {
      const element=document.getElementById(item.element);
      element.replaceChildren();
      const renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});
      renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
      renderer.outputColorSpace=THREE.SRGBColorSpace;
      renderer.setClearColor(0x101c2b);
      element.append(renderer.domElement);
      renderer.domElement.setAttribute('aria-label',item.label+'，拖动旋转，滚轮缩放');
      renderer.domElement.setAttribute('role','img');
      const scene=new THREE.Scene(), camera=new THREE.PerspectiveCamera(35,1,0.1,span*30);
      const controls=new OrbitControls(camera,renderer.domElement);
      controls.enableDamping=false;controls.minDistance=span*0.4;controls.maxDistance=span*10;
      const material=new THREE.MeshStandardMaterial({color:0xa1b3c4,roughness:0.85,metalness:0,flatShading:true});
      scene.add(new THREE.HemisphereLight(0xd6edff,0x374051,2.3));
      const key=new THREE.DirectionalLight(0xffffff,2.7);key.position.set(span,span*2,span);scene.add(key);
      const fill=new THREE.DirectionalLight(0x98c2ed,1.1);fill.position.set(-span,span,-span);scene.add(fill);
      const grid=new THREE.GridHelper(span*2,20,0x2f5362,0x223441);grid.position.set(center.x,frame.min[1]-0.04,center.z);scene.add(grid);
      const viewer={renderer,scene,camera,controls,material,element,observer:null,loaded:false};
      viewers.push(viewer);
      const resize=()=>{
        const width=element.clientWidth,height=element.clientHeight;
        if(width<1||height<1)return;
        renderer.setSize(width,height,false);camera.aspect=width/height;camera.updateProjectionMatrix();renderer.render(scene,camera);
      };
      viewer.observer=new ResizeObserver(resize);viewer.observer.observe(element);
      camera.position.copy(center).add(new THREE.Vector3(1,.72,1.25).multiplyScalar(span*1.5));
      controls.target.copy(center);camera.lookAt(center);controls.update();controls.saveState();
      controls.addEventListener('change',()=>{
        if(syncing||disposed)return;
        syncing=true;
        for(const other of viewers) {
          if(other!==viewer){other.camera.position.copy(camera.position);other.camera.quaternion.copy(camera.quaternion);other.controls.target.copy(controls.target);other.controls.update();}
          other.renderer.render(other.scene,other.camera);
        }
        syncing=false;
      });
      resize();
    }
    await Promise.all(items.map(async(item,i)=>{
      const gltf=await new GLTFLoader().loadAsync(item.url);
      if(disposed)return;
      gltf.scene.traverse(node=>{
        if(node.isMesh){node.geometry.computeVertexNormals();node.material=viewers[i].material;}
      });
      viewers[i].scene.add(gltf.scene);viewers[i].loaded=true;
      viewers[i].renderer.render(viewers[i].scene,viewers[i].camera);
    }));
    return {
      reset(){if(viewers[0])viewers[0].controls.reset();},
      dispose(){
        disposed=true;
        for(const viewer of viewers){
          viewer.controls.dispose();viewer.observer.disconnect();
          viewer.scene.traverse(node=>{if(node.geometry)node.geometry.dispose();});
          viewer.material.dispose();viewer.renderer.dispose();viewer.renderer.forceContextLoss();viewer.element.replaceChildren();
        }
      }
    };
  } catch(error) {
    disposed=true;
    for(const viewer of viewers){viewer.controls.dispose();viewer.observer?.disconnect();viewer.renderer.dispose();viewer.element.replaceChildren();}
    throw error;
  }
}
