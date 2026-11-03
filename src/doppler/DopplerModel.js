// Acoustic Doppler for a stationary listener and a piecewise linear source.
// All distances are metres, times UTC seconds, and positions WGS84 ECEF.
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const addScaled = (a, b, s) => a.map((v, i) => v + b[i]*s);
export const length = a => Math.hypot(...a);
const segmentBounds=new WeakMap();

// Bounds enclose complete finite segments, including turns and gaps. They only
// prune distance calculations; the surviving closest approach stays exact.
function boundsFor(segments,start=0,end=segments.length) {
    const min=[Infinity,Infinity,Infinity],max=[-Infinity,-Infinity,-Infinity];
    for(let i=start;i<end;i++) for(let axis=0;axis<3;axis++) {
        min[axis]=Math.min(min[axis],segments[i].p0[axis],segments[i].p1[axis]);
        max[axis]=Math.max(max[axis],segments[i].p0[axis],segments[i].p1[axis]);
    }
    const node={min,max,start,end};
    if(end-start>8) {
        const middle=(start+end)>>>1;
        node.left=boundsFor(segments,start,middle);node.right=boundsFor(segments,middle,end);
    }
    return node;
}

function boundsDistanceSquared(node,p) {
    let sum=0;
    for(let i=0;i<3;i++) {
        // Round-off padding keeps boundary and tied minima in the exact test.
        const d=Math.max(node.min[i]-p[i]-1e-6,p[i]-node.max[i]-1e-6,0);
        sum+=d*d;
    }
    return sum;
}

export function toECEF(lat, lon, altitudeM = 0) {
    const p = lat*Math.PI/180, l = lon*Math.PI/180;
    const e2 = 6.6943799901413165e-3;
    const n = 6378137/Math.sqrt(1 - e2*Math.sin(p)**2);
    return [(n + altitudeM)*Math.cos(p)*Math.cos(l),
        (n + altitudeM)*Math.cos(p)*Math.sin(l), (n*(1-e2) + altitudeM)*Math.sin(p)];
}

export function navigationVelocity(lat,lon,speed,heading,vertical=0) {
    const p=lat*Math.PI/180,l=lon*Math.PI/180,h=heading*Math.PI/180;
    const east=speed*Math.sin(h),north=speed*Math.cos(h);
    return [-Math.sin(l)*east-Math.sin(p)*Math.cos(l)*north+Math.cos(p)*Math.cos(l)*vertical,
        Math.cos(l)*east-Math.sin(p)*Math.sin(l)*north+Math.cos(p)*Math.sin(l)*vertical,
        Math.cos(p)*north+Math.sin(p)*vertical];
}

export function prepareTrack(track, soundSpeed = 343, maxGap = 30) {
    if (!track.id || !Array.isArray(track.points) || track.points.length < 2) throw new Error("Each flight needs an ID and at least two fixes.");
    const fixes = track.points.map(p => {
        if (![p.time, p.lat, p.lon, p.altitudeM].every(Number.isFinite) || Math.abs(p.lat)>90 || Math.abs(p.lon)>180) {
            throw new Error(`Invalid fix in ${track.id}. Use UTC seconds, degrees and altitude in metres HAE.`);
        }
        const velocity=Number.isFinite(p.groundSpeedMS) && Number.isFinite(p.headingDegrees) ?
            navigationVelocity(p.lat,p.lon,p.groundSpeedMS,p.headingDegrees,Number.isFinite(p.verticalSpeedMS) ? p.verticalSpeedMS : 0) : null;
        return {time:p.time, position:toECEF(p.lat, p.lon, p.altitudeM),velocity};
    }).sort((a,b) => a.time-b.time);
    const segments = [];
    for (let i=1; i<fixes.length; i++) {
        const a = fixes[i-1], b = fixes[i], dt = b.time-a.time;
        if (dt <= 0) throw new Error(`Duplicate timestamps in ${track.id}.`);
        // Never interpolate across missing observations or a discontinuity.
        if (dt > maxGap) continue;
        const velocity = sub(b.position, a.position).map(v => v/dt);
        const speed = length(velocity);
        if (speed >= soundSpeed*0.98) throw new Error(`${track.id} has a near-sonic segment or a position jump. This model requires subsonic flights.`);
        if(a.velocity && length(a.velocity)>=soundSpeed*0.98 || b.velocity && length(b.velocity)>=soundSpeed*0.98) throw new Error(`${track.id} reports a near-sonic velocity. This model requires subsonic flights.`);
        segments.push({t0:a.time, t1:b.time, p0:a.position, p1:b.position, velocity, speed,v0:a.velocity,v1:b.velocity});
    }
    if (!segments.length) throw new Error(`No usable segments in ${track.id}; check the maximum fix gap.`);
    return {id:String(track.id), segments};
}

export function observerTrack(track, observer, soundSpeed, reuse) {
    const view=reuse ?? {id:track.id,segments:track.segments.map(s=>({...s,relative:[0,0,0]}))};
    for(let i=0;i<track.segments.length;i++) {
        const source=track.segments[i],target=view.segments[i],r=target.relative;
        r[0]=source.p0[0]-observer[0];r[1]=source.p0[1]-observer[1];r[2]=source.p0[2]-observer[2];
        target.arrival0=source.t0+Math.hypot(r[0],r[1],r[2])/soundSpeed;
        target.arrival1=source.t1+Math.hypot(source.p1[0]-observer[0],source.p1[1]-observer[1],source.p1[2]-observer[2])/soundSpeed;
    }
    return view;
}

// A source window contains the complete measured flyover. Its nearest passage
// is stable even when fix noise creates several tiny local range minima.
export function nearestApproach(track,soundSpeed=343) {
    let best=null,bestRange=Infinity;
    for(const s of track.segments) {
        const v=s.velocity,r=s.relative,v2=dot(v,v);
        const dt=v2 ? Math.max(0,Math.min(s.t1-s.t0,-dot(r,v)/v2)) : 0;
        const range=Math.hypot(r[0]+v[0]*dt,r[1]+v[1]*dt,r[2]+v[2]*dt);
        if(range>=bestRange) continue;
        bestRange=range;const time=s.t0+dt,u=dt/(s.t1-s.t0);
        const speed=s.v0 && s.v1 ? Math.hypot(...s.v0.map((v,i)=>v+(s.v1[i]-v)*u)) : s.speed;
        best={time,arrival:time+range/soundSpeed,range,speed};
    }
    return best;
}

// Test the exact nearest passage before building an observer view. Rejected
// observers do not need every segment's endpoint arrival times for scoring.
export function nearestApproachFromObserver(track,observer,soundSpeed=343,maxRange=Infinity) {
    if(!track.segments.length) return null;
    let root=segmentBounds.get(track);
    if(!root) {root=boundsFor(track.segments);segmentBounds.set(track,root);}
    let best=null,bestRange=maxRange,bestIndex=Infinity;
    const stack=[root];
    while(stack.length) {
        const node=stack.pop();
        if(boundsDistanceSquared(node,observer)>bestRange*bestRange*(1+1e-12)) continue;
        if(node.left) {
            const left=boundsDistanceSquared(node.left,observer),right=boundsDistanceSquared(node.right,observer);
            if(left<=right) stack.push(node.right,node.left);else stack.push(node.left,node.right);
            continue;
        }
        for(let index=node.start;index<node.end;index++) {
            const s=track.segments[index];
            const v=s.velocity,r0=s.p0[0]-observer[0],r1=s.p0[1]-observer[1],r2=s.p0[2]-observer[2];
            const v2=dot(v,v),rv=r0*v[0]+r1*v[1]+r2*v[2];
            const dt=v2 ? Math.max(0,Math.min(s.t1-s.t0,-rv/v2)) : 0;
            const range=Math.hypot(r0+v[0]*dt,r1+v[1]*dt,r2+v[2]*dt);
            if(range>bestRange || range===bestRange && index>=bestIndex) continue;
            bestRange=range;bestIndex=index;const time=s.t0+dt,u=dt/(s.t1-s.t0);
            const speed=s.v0 && s.v1 ? Math.hypot(s.v0[0]+(s.v1[0]-s.v0[0])*u,
                s.v0[1]+(s.v1[1]-s.v0[1])*u,s.v0[2]+(s.v1[2]-s.v0[2])*u) : s.speed;
            best={time,arrival:time+range/soundSpeed,range,speed};
        }
    }
    return best;
}

// Solve t_receive = t_emit + range(t_emit)/c. Evaluating velocity at reception
// and merely shifting the resulting curve gives the wrong frequency history.
export function atArrival(track, arrivalTime, soundSpeed = 343, factorOnly = false) {
    const a = track.segments;
    let lo=0, hi=a.length;
    while (lo<hi) {
        const m=(lo+hi)>>>1;
        if (a[m].arrival1 < arrivalTime) lo=m+1; else hi=m;
    }
    const s=a[lo];
    if (!s || arrivalTime < s.arrival0 || arrivalTime > s.arrival1) return null;
    const v=s.velocity,dt=arrivalTime-s.t0;
    const q0=s.relative[0]+v[0]*dt,q1=s.relative[1]+v[1]*dt,q2=s.relative[2]+v[2]*dt;
    const qv=q0*v[0]+q1*v[1]+q2*v[2],squared=q0*q0+q1*q1+q2*q2,k=soundSpeed**2-dot(v,v);
    const delay=squared===0 ? 0 : squared/(Math.sqrt(qv*qv+k*squared)+qv);
    const emissionTime=arrivalTime-delay,u=(emissionTime-s.t0)/(s.t1-s.t0),offset=emissionTime-s.t0;
    const r0=s.relative[0]+v[0]*offset,r1=s.relative[1]+v[1]*offset,r2=s.relative[2]+v[2]*offset;
    const range=Math.hypot(r0,r1,r2);
    if(range<1) return null;
    // Navigation velocity is measured independently of the position fixes.
    const v0=s.v0 && s.v1 ? s.v0[0]+(s.v1[0]-s.v0[0])*u : v[0];
    const v1=s.v0 && s.v1 ? s.v0[1]+(s.v1[1]-s.v0[1])*u : v[1];
    const v2=s.v0 && s.v1 ? s.v0[2]+(s.v1[2]-s.v0[2])*u : v[2];
    const radialVelocity=(r0*v0+r1*v1+r2*v2)/range,factor=soundSpeed/(soundSpeed+radialVelocity);
    return factorOnly ? factor : {emissionTime,range,radialVelocity,factor};
}

export function closestApproaches(track, soundSpeed = 343) {
    const values=track.segments.map(s => {
        const v2=dot(s.velocity,s.velocity);
        const dt=v2 ? Math.max(0,Math.min(s.t1-s.t0,-dot(s.relative,s.velocity)/v2)) : 0;
        const range=length(addScaled(s.relative,s.velocity,dt));
        const time=s.t0+dt;
        const u=dt/(s.t1-s.t0),v=s.v0 && s.v1 ? s.v0.map((v,i)=>v+(s.v1[i]-v)*u) : s.velocity;
        return {time, arrival:time+range/soundSpeed, range, speed:length(v)};
    });
    return values.filter((v,i) => {
        const prev=values[i-1], next=values[i+1];
        const contiguousPrev=prev && track.segments[i-1].t1 === track.segments[i].t0;
        const contiguousNext=next && track.segments[i].t1 === track.segments[i+1].t0;
        return (!contiguousPrev || (v.range<=prev.range && Math.abs(v.time-prev.time)>1e-5)) &&
            (!contiguousNext || v.range<=next.range);
    });
}

// The ideal straight-flight curve is useful when measuring broad speed/range
// bounds. Search uses the actual flight geometry instead.
export function idealFrequency(timeFromDelayedCPA, frequency, speed, range, soundSpeed=343) {
    const track={segments:[{t0:-1e6,t1:1e6,p0:[-speed*1e6,range,0],p1:[speed*1e6,range,0],velocity:[speed,0,0],speed}]};
    return atArrival(observerTrack(track,[0,0,0],soundSpeed),timeFromDelayedCPA+range/soundSpeed,soundSpeed).factor*frequency;
}
