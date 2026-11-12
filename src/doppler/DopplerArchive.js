import {toECEF} from "./DopplerModel";

const decoder=new TextDecoder();
const pause=()=>new Promise(resolve=>setTimeout(resolve,0));

// Read across split tar parts without materialising a multi-gigabyte archive.
// Files stay in the browser; only a small read cache and the sparse flight index
// live in worker memory. Nothing is extracted into a filesystem path.
export class FlightArchive {
    constructor(files) {
        this.files=[...files].sort((a,b)=>a.name.localeCompare(b.name));
        this.size=this.files.reduce((n,f)=>n+f.size,0);
        this.cache=null;
    }
    async range(offset,length) {
        if(offset<0 || offset+length>this.size) throw new Error("Flight archive is truncated. Select every split part in the daily release.");
        const pieces=[];let start=0,remaining=length;
        for(const file of this.files) {
            const local=offset-start;
            if(local<file.size && remaining>0) {
                const count=Math.min(remaining,file.size-Math.max(0,local));
                pieces.push(file.slice(Math.max(0,local),Math.max(0,local)+count));offset+=count;remaining-=count;
            }
            start+=file.size;
        }
        return new Uint8Array(await new Blob(pieces).arrayBuffer());
    }
    async bytes(offset,length) {
        if(this.cache && offset>=this.cache.start && offset+length<=this.cache.start+this.cache.data.length) {
            return this.cache.data.subarray(offset-this.cache.start,offset-this.cache.start+length);
        }
        if(length>8*1024*1024) return this.range(offset,length);
        const data=await this.range(offset,Math.min(this.size-offset,8*1024*1024));
        this.cache={start:offset,data};return data.subarray(0,length);
    }
    async *entries() {
        let offset=0;
        while(offset+512<=this.size) {
            const header=await this.bytes(offset,512);
            if(header.every(v=>v===0)) return;
            const name=decoder.decode(header.subarray(0,100)).replace(/\0.*$/s,"");
            const prefix=decoder.decode(header.subarray(345,500)).replace(/\0.*$/s,"");
            const sizeText=decoder.decode(header.subarray(124,136)).replace(/\0.*$/s,"").trim();
            if(!/^[0-7]+$/.test(sizeText)) throw new Error("Unsupported or corrupt tar header in flight archive.");
            const size=parseInt(sizeText,8);
            if(!Number.isSafeInteger(size) || offset+512+size>this.size) throw new Error("Flight archive is truncated or corrupt. Select every split part.");
            yield {name:prefix ? `${prefix}/${name}` : name,offset:offset+512,size};
            offset+=512+Math.ceil(size/512)*512;
        }
        if(offset!==this.size) throw new Error("Incomplete tar header at the end of the flight archive.");
    }
    async json(entry,cached=true) {
        const compressed=await (cached ? this.bytes(entry.offset,entry.size) : this.range(entry.offset,entry.size));
        const stream=new Blob([compressed]).stream();
        const plain=compressed[0]===31 && compressed[1]===139 ? stream.pipeThrough(new DecompressionStream("gzip")) : stream;
        return new Response(plain).json();
    }
}

class Samples {
    constructor() {this.length=0;this.capacity=0;this.grow();}
    grow() {
        const capacity=Math.min(this.capacity ? this.capacity*2 : 65536,16000000);
        // The final allocation can be smaller than a doubling. Rejecting that
        // doubling would stop at 8,388,608 fixes despite the 16-million limit.
        if(capacity<=this.capacity) throw new Error("Sparse flight index is too large. Narrow the archive bounds or recording date.");
        this.capacity=capacity;
        for(const key of ["x","y","z","time","lat","lon"]) {
            const next=new Float64Array(this.capacity);if(this[key]) next.set(this[key]);this[key]=next;
        }
        for(const [key,Type] of [["flight",Uint32Array],["speedMin",Float32Array],["speedMax",Float32Array],["flags",Uint8Array]]) {
            const next=new Type(this.capacity);if(this[key]) next.set(this[key]);this[key]=next;
        }
    }
    add(flight,time,lat,lon,altitude,speed,flags) {
        if(this.length===this.capacity) this.grow();
        const i=this.length++,p=toECEF(lat,lon,altitude);
        this.x[i]=p[0];this.y[i]=p[1];this.z[i]=p[2];this.time[i]=time;this.lat[i]=lat;this.lon[i]=lon;
        this.flight[i]=flight;this.speedMin[i]=speed;this.speedMax[i]=speed;this.flags[i]=flags;
    }
}

// The ICAO type list ships with Sitrec: data/aircraft/icao_aircraft_types.json, from the
// Mictronics aircraft database under the ODC Attribution License (see data/aircraft/README.md).
// DopplerTool passes its URL as options.typesURL, because this runs in a worker that cannot
// read the app path itself.
export async function loadAircraftTypes(url) {
    if(!url) throw new Error("No aircraft type list was given. Include all aircraft types, or reopen Doppler geolocation.");
    const response=await fetch(url);
    if(!response.ok) throw new Error(`Aircraft type list did not load (${response.status}). Retry or include all aircraft types.`);
    return response.json();
}

// readsb trace altitudes and speeds have explicit feet/knots units. Geometric
// altitude is preferred; a barometric fallback is opt-in and counted visibly.
export function traceFix(row,base,{allowBarometric=false}={}) {
    const geometric=typeof row[10]==="number" ? row[10] : (row[6]&8) && typeof row[3]==="number" ? row[3] : null;
    const altitude=geometric ?? (allowBarometric && typeof row[3]==="number" ? row[3] : null);
    if(altitude===null || ![row[0],row[1],row[2],altitude].every(Number.isFinite) || Math.abs(row[1])>90 || Math.abs(row[2])>180) return null;
    const speed=typeof row[4]==="number" ? row[4]*0.514444444444 : null;
    const vertical=typeof row[11]==="number" ? row[11] : typeof row[7]==="number" ? row[7] : null;
    return {time:base+row[0],lat:row[1],lon:row[2],altitudeM:altitude*0.3048,
        speed,groundSpeedMS:speed,headingDegrees:typeof row[5]==="number" ? row[5] : null,
        verticalSpeedMS:vertical===null ? null : vertical*0.00508,approximateAltitude:geometric===null};
}

export async function scanFlightArchive(archive,events,options={},progress=()=>{}) {
    const bounds=options.bounds ?? [24,-125,50,-66],step=options.sampleStep ?? 30;
    if(bounds.length!==4 || !bounds.every(Number.isFinite) || bounds[0]>=bounds[2] || bounds[1]>=bounds[3] || step<5) throw new Error("Check the archive latitude/longitude bounds and sample interval.");
    const types=options.types ?? (options.excludeJets ? await loadAircraftTypes(options.typesURL) : {});
    const flights=[],samples=new Samples(),stats={read:0,flights:0,fixes:0,approximateAltitudes:0,missingAltitudes:0};
    const seen=new Set();
    for await(const entry of archive.entries()) {
        if(!/(?:^|\/)trace_full_[^/]+\.json(?:\.gz)?$/.test(entry.name)) continue;
        const data=await archive.json(entry);stats.read++;
        if(!Array.isArray(data.trace) || !Number.isFinite(data.timestamp)) continue;
        // Event filters must not remove aircraft from the silence check.
        const eventEligible=!(options.excludeJets && types[data.t]?.desc?.endsWith("J"));
        const id=String(data.icao ?? entry.name),key=`${id}/${data.timestamp}`;
        if(seen.has(key)) continue;seen.add(key);
        const flight=flights.length;let previousBucket=null,callsign="",retained=0;
        for(const row of data.trace) {
            if(row[8]?.flight) callsign=String(row[8].flight).trim();
            const fix=traceFix(row,data.timestamp,options);
            if(!fix) {stats.missingAltitudes++;continue;}
            if(fix.lat<bounds[0] || fix.lat>bounds[2] || fix.lon<bounds[1] || fix.lon>bounds[3]) continue;
            stats.fixes++;if(fix.approximateAltitude) stats.approximateAltitudes++;
            if(fix.speed===null || fix.speed<20 || fix.speed>330 || fix.altitudeM>20000) continue;
            const bucket=Math.floor(fix.time/step);
            if(bucket===previousBucket) {
                const i=samples.length-1;
                samples.speedMin[i]=Math.min(samples.speedMin[i],fix.speed);
                samples.speedMax[i]=Math.max(samples.speedMax[i],fix.speed);
                if(eventEligible) events.forEach((e,j)=>{if(fix.speed>=e.speedMin && fix.speed<=e.speedMax) samples.flags[i]|=1<<j;});
                continue;
            }
            previousBucket=bucket;
            let flags=0;
            if(eventEligible) events.forEach((e,i)=>{if(fix.speed>=e.speedMin && fix.speed<=e.speedMax) flags|=1<<i;});
            samples.add(flight,fix.time,fix.lat,fix.lon,fix.altitudeM,fix.speed,flags);retained++;
        }
        if(retained) flights.push({...entry,id,base:data.timestamp,aircraftType:String(data.t ?? "Unknown"),registration:String(data.r ?? ""),callsign,eventEligible});
        if(stats.read%100===0) {
            stats.flights=flights.length;progress({phase:"Reading flight archive",done:entry.offset,total:archive.size,...stats,samples:samples.length});
            await pause();
        }
    }
    if(!flights.length) throw new Error("No usable airborne fixes in this archive and region. Check the bounds and altitude availability.");
    stats.flights=flights.length;
    return {archive,flights,samples,stats,options};
}

export async function readArchiveTrack(dataset,flightIndex,from=-Infinity,to=Infinity) {
    const meta=dataset.flights[flightIndex],data=await dataset.archive.json(meta,false);
    const points=[],seen=new Set();let activeCallsign="",callsign=meta.callsign;
    for(const row of data.trace) {
        if(row[8]?.flight) activeCallsign=String(row[8].flight).trim();
        const p=traceFix(row,data.timestamp,dataset.options);
        if(!p || p.time<from || p.time>to || seen.has(p.time)) continue;
        if(activeCallsign) callsign=activeCallsign;
        seen.add(p.time);points.push(p);
    }
    return {id:meta.id,aircraftType:meta.aircraftType,registration:meta.registration,callsign,points};
}
