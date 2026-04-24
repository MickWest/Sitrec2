import {altitudeAboveSphere, getLocalUpVector} from "../SphericalMath";
import {NodeMan, Sit} from "../Globals";
import {CNodeTrack} from "./CNodeTrack";
import {assert} from "../assert";
import {V3} from "../threeUtils";
import {CNodeGUIValue} from "./CNodeGUIValue";

/**
 * Calculate air density based on altitude using the barometric formula
 * This is a simplified model that works reasonably well up to ~10km
 * @param {number} altitude - Altitude in meters above sea level
 * @returns {number} Air density in kg/m³
 */
function getAirDensity(altitude) {
    // Sea level standard atmospheric pressure (Pa)
    const P0 = 101325
    // Sea level standard temperature (K)
    const T0 = 288.15
    // Temperature lapse rate (K/m)
    const L = 0.0065
    // Universal gas constant for air (J/(kg·K))
    const R = 287.05
    // Gravitational acceleration (m/s²)
    const g = 9.80665
    
    // Calculate temperature at altitude
    const T = T0 - L * altitude
    
    // Calculate pressure at altitude using barometric formula
    const P = P0 * Math.pow(T / T0, g / (R * L))
    
    // Calculate density using ideal gas law: ρ = P / (R * T)
    const rho = P / (R * T)
    
    return rho
}

/**
 * CNodeHomingMissileTrack - Simulates a missile with proportional navigation guidance
 * 
 * This node creates a track for a missile that uses Proportional Navigation (PN) guidance
 * to intercept a target. The missile physics includes:
 * - Thrust (with configurable burn time)
 * - Drag (atmospheric resistance based on altitude)
 * - Gravity
 * - Proportional Navigation guidance
 * - Augmented PN for target acceleration compensation
 * 
 * Guidance System Configuration:
 * - Navigation Gain: 3-5 (configurable)
 * - Max Lateral Acceleration: 100-300 m/s² (configurable)
 * - Min Effective Closing Velocity: 50 m/s (ensures guidance works at launch)
 * - Thrust Direction: Blends from target-pointing to velocity-aligned (30% min toward target)
 * - LOS Rate Threshold: 0.00001 rad/s (very sensitive)
 * - Lateral Force Threshold: 0.001 m/s² (applies even small corrections)
 * 
 * The guidance can use either:
 * 1. Pure Proportional Navigation - lateral acceleration to null LOS rotation (default)
 * 2. Augmented PN - adds compensation for target acceleration (optional via checkbox)
 */
export class CNodeHomingMissileTrack extends CNodeTrack {
    constructor(v) {
        if (v.frames === undefined) {
            v.frames = Sit.frames;
            super(v);
            this.useSitFrames = true;
        } else {
            super(v);
        }

        this.enabled = (v.enabled !== undefined) ? v.enabled : true;


        this.addInput("enabled", new CNodeGUIValue({
            value: this.enabled,
            type: "boolean",
            desc: "Enable the missile",
            gui: "missile",
            tooltip: "Enable Simulated Homing Missile using Proportional Navigation (PN) guidance"
        }))

        // Create input nodes if they don't exist
        this.addInput("startFrame", new CNodeGUIValue({
            value: 0,
            start: -900,
            end: 900,
            step: 1,
            desc: "Start Frame",
            gui: "missile",
            tooltip: "Frame at which the missile launches"
        }))

        this.addInput("mass", new CNodeGUIValue({
            value: 10,
            start: 1,
            end: 100,
            step: 0.1,
            desc: "Mass (kg)",
            gui: "missile",
            tooltip: "Mass of the missile in kilograms"
        }))

        this.addInput("thrust", new CNodeGUIValue({
            value: 500,
            start: 0,
            end: 10000,
            step: 10,
            desc: "Thrust (N)",
            gui: "missile",
            tooltip: "Thrust force in Newtons"
        }))

        this.addInput("dragCoefficient", new CNodeGUIValue({
            value: 0.3,
            start: 0,
            end: 2,
            step: 0.01,
            desc: "Drag Coefficient (Cd)",
            gui: "missile",
            tooltip: "Aerodynamic drag coefficient (typical: 0.2-0.5 for missiles)"
        }))

        this.addInput("referenceArea", new CNodeGUIValue({
            value: 0.01,
            start: 0.001,
            end: 1,
            step: 0.001,
            desc: "Reference Area (m²)",
            gui: "missile",
            tooltip: "Cross-sectional area of the missile in square meters"
        }))

        this.addInput("burnTime", new CNodeGUIValue({
            value: 5,
            start: 0,
            end: 60,
            step: 0.1,
            desc: "Burn Time (s)",
            gui: "missile",
            tooltip: "Duration of thrust in seconds"
        }))

        this.addInput("navigationGain", new CNodeGUIValue({
            value: 3,
            start: 1,
            end: 10,
            step: 0.1,
            desc: "Navigation Gain (N)",
            gui: "missile",
            tooltip: "Proportional navigation gain constant (typical: 3-5)"
        }))

        this.addInput("maxLateralAccel", new CNodeGUIValue({
            value: 100,
            start: 10,
            end: 300,
            step: 5,
            desc: "Max Lateral Accel (m/s²)",
            gui: "missile",
            tooltip: "Maximum lateral acceleration the missile can achieve"
        }))

        this.addInput("useAugmentedPN", new CNodeGUIValue({
            value: false,
            type: "boolean",
            desc: "Use Augmented PN",
            gui: "missile",
            tooltip: "Enable Augmented Proportional Navigation to compensate for target acceleration"
        }))

        this.requireInputs(["source", "target"])
        this.isNumber = false;
        
        // Store previous LOS for rate calculation
        this.prevLOS = null;
        
        this.recalculate()
    }

    recalculate() {

        const showObject = (obName) => {
            const ob = NodeMan.get(obName, false);
            if (ob) {
                ob.show(this.enabled);
                ob.enabled = this.enabled
            }
        }

        // patch, not working missiles disabled for now.
        showObject("missileObject")
        showObject("displayMissileTrack")
        showObject("speedGraphForMissile")
        showObject("moveMissileAlongPath")


        if (!this.enabled) {
            this.hide();
            return;
        }

        this.array = []

        const startFrame = this.in.startFrame.v0;
        const mass = this.in.mass.v0 // kg
        const thrust = this.in.thrust.v0 // Newtons
        const dragCoefficient = this.in.dragCoefficient.v0 // Cd (dimensionless)
        const referenceArea = this.in.referenceArea.v0 // m²
        const burnTime = this.in.burnTime.v0 // seconds
        const navigationGain = this.in.navigationGain.v0 ?? 5.0 // Higher PN gain for good tracking (typical 3-5)
        const maxLateralAccel = this.in.maxLateralAccel.v0 ?? 200.0 // m/s² (about 20g) - reasonable for a missile
        const burnFrames = Math.floor(burnTime * Sit.fps)
        const endBurnFrame = startFrame + burnFrames





        const dt = 1.0 / Sit.fps // time step in seconds
        const gravity = 9.81 // m/s^2
        
        // Previous LOS vector for rate calculation
        let prevLOS = null

        // we allow a negative start frame to simulate a missile launched in the past
        // and start out caculations either there, or at zero.
        // (if zero, then the intial frames will just copy the source track until launch)
        const calculationStartFrame = Math.min(startFrame, 0);

        // Initialize position and velocity from source track
        let missilePos = this.in.source.p(calculationStartFrame).clone()
        let missileVel = V3(0, 0, 0)

        // Get initial velocity from source track if it's moving
        if (this.in.source.frames > 1) {
            const sourcePos0 = this.in.source.p(0)
            const sourcePos1 = this.in.source.p(1)
            missileVel = sourcePos1.clone().sub(sourcePos0).multiplyScalar(Sit.fps)
        }

        for (let f = calculationStartFrame; f < this.frames; f++) {
            // Store current position
            const trackPoint = {
                position: missilePos.clone(),
                velocity: missileVel.clone(),
            }
            if (f >= 0) {
                this.array.push(trackPoint)
            }

            // Before start frame, mirror the source track
            if (f < startFrame) {
                missilePos = this.in.source.p(f).clone()
                if (f < this.in.source.frames - 1) {
                    const sourcePos0 = this.in.source.p(f)
                    const sourcePos1 = this.in.source.p(f + 1)
                    missileVel = sourcePos1.clone().sub(sourcePos0).multiplyScalar(Sit.fps)
                }
                // Initialize prevLOS just before launch
                if (f === startFrame - 1) {
                    const targetFrame = Math.min(f, this.in.target.frames - 1)
                    const targetPos = this.in.target.p(targetFrame)
                    prevLOS = targetPos.clone().sub(missilePos)
                }
                continue
            }

            // Get target position and velocity
            const targetFrame = Math.min(f, this.in.target.frames - 1)
            const targetPos = this.in.target.p(targetFrame)
            
            let targetVel = V3(0, 0, 0)
            if (targetFrame < this.in.target.frames - 1) {
                const targetPos0 = this.in.target.p(targetFrame)
                const targetPos1 = this.in.target.p(targetFrame + 1)
                targetVel = targetPos1.clone().sub(targetPos0).multiplyScalar(Sit.fps)
            }

            // Calculate Line of Sight (LOS) vector from missile to target
            const LOS = targetPos.clone().sub(missilePos)
            const range = LOS.length()
            
            // Normalize LOS to get unit vector
            const LOSUnit = range > 0 ? LOS.clone().normalize() : V3(0, 0, 1)
            
            // Calculate commanded acceleration using Proportional Navigation
            let commandedAccel = V3(0, 0, 0)
            
            if (range > 1.0 && prevLOS !== null && prevLOS.length() > 0) {
                // Calculate LOS rate directly from change in LOS
                // This is more robust than using relative velocity
                const LOSdot = LOS.clone().sub(prevLOS).multiplyScalar(Sit.fps)
                
                // Calculate closing velocity (how fast the range is decreasing)
                const closingVelocity = -(targetVel.clone().sub(missileVel)).dot(LOSUnit)
                
                // Calculate the LOS angular rate vector
                // ω = (LOS × LOS_dot) / |LOS|²
                const LOSRateVector = LOS.clone().cross(LOSdot).divideScalar(range * range)
                const LOSRateMagnitude = LOSRateVector.length()
                

                
                // Apply PN guidance whenever there's any LOS rotation at all
                // Very aggressive - even tiny LOS rates will cause guidance
                if (LOSRateMagnitude > 0.00001) {  // Very low threshold
                    // The acceleration should be perpendicular to LOS
                    // Direction: perpendicular component of LOS_dot normalized
                    const LOSdotPerp = LOSdot.clone().sub(
                        LOSUnit.clone().multiplyScalar(LOSdot.dot(LOSUnit))
                    )
                    
                    // Acceleration direction is perpendicular to LOS, in direction of LOS rotation
                    // We want to accelerate to REDUCE the rotation, so we use LOSdotPerp direction
                    let accelDirection = V3(0, 0, 0)
                    if (LOSdotPerp.length() > 0.01) {
                        // The acceleration should be in the direction of LOSdotPerp
                        // to null out the LOS rotation
                        accelDirection = LOSdotPerp.clone().normalize()
                    }
                    
                    // Standard PN: a = N * Vc * ω
                    // Use max of closing velocity or a minimum value to ensure guidance works at launch
                    // Use reasonable minimum to ensure guidance works even with low closing velocity
                    const effectiveClosingVel = Math.max(closingVelocity, 50.0) // minimum 50 m/s for effective guidance
                    const PN_accel = accelDirection.multiplyScalar(
                        navigationGain * effectiveClosingVel * LOSRateMagnitude
                    )
                    commandedAccel.add(PN_accel)
                    
                    // Debug output for first few frames after launch (compact version)
                    // if (f >= startFrame && f < startFrame + 5) {  // Just first 5 frames
                    //     console.log(`Frame ${f}: Range=${range.toFixed(0)}m, Speed=${missileVel.length().toFixed(0)}m/s, ClosingVel=${closingVelocity.toFixed(0)}m/s, LOSRate=${LOSRateMagnitude.toFixed(3)}rad/s, PNAccel=${PN_accel.length().toFixed(0)}m/s², TotalAccel=${commandedAccel.length().toFixed(0)}m/s²`)
                    // }
                }
                
                // Augmented PN: add target acceleration compensation (if enabled)
                const useAugmentedPN = this.in.useAugmentedPN?.v0 ?? false
                if (useAugmentedPN) {
                    let targetAccel = V3(0, 0, 0)
                    if (targetFrame < this.in.target.frames - 2) {
                        const targetPos0 = this.in.target.p(targetFrame)
                        const targetPos1 = this.in.target.p(targetFrame + 1)
                        const targetPos2 = this.in.target.p(targetFrame + 2)
                        const targetVel0 = targetPos1.clone().sub(targetPos0).multiplyScalar(Sit.fps)
                        const targetVel1 = targetPos2.clone().sub(targetPos1).multiplyScalar(Sit.fps)
                        targetAccel = targetVel1.clone().sub(targetVel0).multiplyScalar(Sit.fps)
                    }
                    
                    // Project target acceleration perpendicular to LOS
                    const targetAccelPerp = targetAccel.clone().sub(LOSUnit.clone().multiplyScalar(targetAccel.dot(LOSUnit)))
                    
                    // Augmented PN term: (N/2) * target_accel_perpendicular
                    const APN_accel = targetAccelPerp.multiplyScalar(navigationGain / 2.0)
                    commandedAccel.add(APN_accel)
                }
                
                // Clamp to maximum lateral acceleration
                const commandedAccelMag = commandedAccel.length()
                if (commandedAccelMag > maxLateralAccel) {
                    commandedAccel.multiplyScalar(maxLateralAccel / commandedAccelMag)
                }
            }
            
            // Store current LOS for next iteration
            prevLOS = LOS.clone()

            // Calculate forces
            const localUp = getLocalUpVector(missilePos)
            const gravityForce = localUp.clone().multiplyScalar(-gravity * mass)

            let totalForce = gravityForce.clone()

            // Add thrust if still burning
            if (f < endBurnFrame) {
                // Thrust direction logic:
                // - At launch: point toward target
                // - After launch: blend velocity direction with desired direction based on guidance
                let thrustDir
                
                const speed = missileVel.length()
                if (speed < 1.0) {
                    // At launch, point directly at target
                    thrustDir = LOSUnit.clone()
                } else {
                    // After launch, primarily thrust along velocity direction
                    // but allow some steering toward target
                    const velDir = missileVel.clone().normalize()
                    
                    // Blend velocity direction with target direction for better guidance
                    // Gradually transition from target-pointing to velocity-aligned as speed increases
                    const blendFactor = Math.min(speed / 100.0, 0.7) // Max 0.7, so always at least 30% toward target
                    thrustDir = velDir.multiplyScalar(blendFactor)
                        .add(LOSUnit.clone().multiplyScalar(1.0 - blendFactor))
                        .normalize()
                }
                
                const thrustForce = thrustDir.multiplyScalar(thrust)
                totalForce.add(thrustForce)
                

            }
            
            // Add the commanded lateral acceleration as a force
            // This represents control surfaces or thrust vectoring
            // This is the ONLY place we apply the PN guidance command
            // VERY AGGRESSIVE - apply even tiny guidance commands
            if (commandedAccel.length() > 0.001) {
                const lateralForce = commandedAccel.clone().multiplyScalar(mass)
                totalForce.add(lateralForce)
                

            }

            // Add air resistance using physically accurate drag equation
            // F_drag = 0.5 × ρ × C_d × A × v²
            const speed = missileVel.length()
            if (speed > 0) {
                // Get altitude above sea level
                const altitude = altitudeAboveSphere(missilePos) // meters above sea level
                
                // Get air density at current altitude
                const airDensity = getAirDensity(altitude) // kg/m³
                
                // Calculate drag force magnitude: F = 0.5 × ρ × C_d × A × v²
                const dragMagnitude = 0.5 * airDensity * dragCoefficient * referenceArea * speed * speed
                
                // Clamp drag force to prevent it from reversing velocity in one timestep
                // Maximum drag deceleration should not exceed current velocity / dt
                const maxDragForce = mass * speed / dt
                const clampedDragMagnitude = Math.min(dragMagnitude, maxDragForce)
                const dragForce = missileVel.clone().normalize().multiplyScalar(-clampedDragMagnitude)
                totalForce.add(dragForce)
            }

            // Calculate acceleration (F = ma)
            const acceleration = totalForce.divideScalar(mass)
            


            // Update velocity and position using Euler integration
            missileVel.add(acceleration.multiplyScalar(dt))
            missilePos.add(missileVel.clone().multiplyScalar(dt))
        }

        assert(this.frames == this.array.length, "frames length mismatch");
    }

    update(f) {
        super.update(f)
        if (f < this.startFrame) {
            this.hide();
        } else {
            this.show();
        }
    }

}