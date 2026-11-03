// Worker-side terrain for large searches. The app's compact EGM96 asset keeps
// terrain and geometric flight altitudes in the same HAE datum.
export class DopplerElevation {
    constructor(geoidURL,{zoom=11,terrainURL="https://s3.amazonaws.com/elevation-tiles-prod/terrarium"}={}) {
        this.geoidURL=geoidURL;this.zoom=zoom;this.terrainURL=terrainURL;this.tiles=new Map();
    }
    async initialize() {
        const response=await fetch(this.geoidURL);
        if(!response.ok) throw new Error(`Geoid data could not load (${response.status}).`);
        const raw=new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
        const n=721*1440;
        if(raw.length!==2*n) throw new Error("Unexpected geoid data size.");
        this.geoid=new Float32Array(n);
        for(let row=0;row<721;row++) {
            let sum=0;
            for(let col=0;col<1440;col++) {
                const i=row*1440+col;sum=(sum+raw[i]+raw[n+i]*256)&65535;
                this.geoid[i]=((sum<<16)>>16)/100;
            }
        }
    }
    geoidAt(lat,lon) {
        const y=Math.max(0,Math.min(719.999999,(90-lat)*4)),x=((lon%360+360)%360)*4;
        const r=Math.floor(y),c=Math.floor(x),fx=x-c,fy=y-r,g=this.geoid;
        return (g[r*1440+c]*(1-fx)+g[r*1440+(c+1)%1440]*fx)*(1-fy)+
            (g[(r+1)*1440+c]*(1-fx)+g[(r+1)*1440+(c+1)%1440]*fx)*fy;
    }
    async tile(x,y) {
        const key=`${this.zoom}/${x}/${y}`;
        if(this.tiles.has(key)) {const found=this.tiles.get(key);this.tiles.delete(key);this.tiles.set(key,found);return found;}
        const operation=(async()=>{
            const response=await fetch(`${this.terrainURL}/${key}.png`);
            if(!response.ok) throw new Error(`Terrain tile ${key} could not load (${response.status}).`);
            const bitmap=await createImageBitmap(await response.blob());
            const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),ctx=canvas.getContext("2d");
            ctx.drawImage(bitmap,0,0);bitmap.close();
            const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
            const heights=new Float32Array(canvas.width*canvas.height);
            for(let i=0;i<heights.length;i++) heights[i]=pixels[i*4]*256+pixels[i*4+1]+pixels[i*4+2]/256-32768;
            return {heights,width:canvas.width};
        })();
        this.tiles.set(key,operation);
        if(this.tiles.size>128) this.tiles.delete(this.tiles.keys().next().value);
        try {return await operation;} catch(error) {this.tiles.delete(key);throw error;}
    }
    async at(lat,lon) {
        const count=2**this.zoom,x=(lon+180)/360*count,y=(1-Math.asinh(Math.tan(lat*Math.PI/180))/Math.PI)/2*count;
        // Pixel centres, rather than pixel corners, are the terrain samples.
        const px=x*256-0.5,py=y*256-0.5,ix=Math.floor(px),iy=Math.floor(py),fx=px-ix,fy=py-iy;
        const pixel=async(a,b)=>{
            const tx=((Math.floor(a/256)%count)+count)%count,ty=Math.max(0,Math.min(count-1,Math.floor(b/256)));
            const tile=await this.tile(tx,ty);
            return tile.heights[((b%256+256)%256)*tile.width+(a%256+256)%256];
        };
        const [a,b,c,d]=await Promise.all([pixel(ix,iy),pixel(ix+1,iy),pixel(ix,iy+1),pixel(ix+1,iy+1)]);
        const msl=(a*(1-fx)+b*fx)*(1-fy)+(c*(1-fx)+d*fx)*fy;
        return Math.max(0,msl)+this.geoidAt(lat,lon);
    }
}
