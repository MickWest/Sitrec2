
/**
 * lil-gui
 * https://lil-gui.georgealways.com
 * @version 0.19.1
 * @author George Michael Brower
 * @license MIT
 */

// MICK: Note modifications by me, labled "MICK"
// If you upgrade version, then you will probably want to carry over the modifications

import {assert} from "../assert";
import {setRenderOne} from "../Globals";
import {showError} from "../showError";
import {cleanFloat} from "../utils";

/**
 * Base class for all controllers.
 */
class Controller {

    constructor( parent, object, property, className, elementType = 'div' ) {

        /**
         * The GUI that contains this controller.
         * @type {GUI}
         */
        this.parent = parent;

        /**
         * The object this controller will modify.
         * @type {object}
         */
        this.object = object;

        /**
         * The name of the property to control.
         * @type {string}
         */
        this.property = property;

        /**
         * Used to determine if the controller is disabled.
         * Use `controller.disable( true|false )` to modify this value.
         * @type {boolean}
         */
        this._disabled = false;

        /**
         * Used to determine if the Controller is hidden.
         * Use `controller.show()` or `controller.hide()` to change this.
         * @type {boolean}
         */
        this._hidden = false;

        /**
         * The value of `object[ property ]` when the controller was created.
         * @type {any}
         */
        this.initialValue = this.getValue();

        /**
         * The outermost container DOM element for this controller.
         * @type {HTMLElement}
         */
        this.domElement = document.createElement( elementType );
        this.domElement.classList.add( 'controller' );
        this.domElement.classList.add( className );

        /**
         * The DOM element that contains the controller's name.
         * @type {HTMLElement}
         */
        this.$name = document.createElement( 'div' );
        this.$name.classList.add( 'name' );

        Controller.nextNameID = Controller.nextNameID || 0;
        this.$name.id = `lil-gui-name-${++Controller.nextNameID}`;

        /**
         * The DOM element that contains the controller's "widget" (which differs by controller type).
         * @type {HTMLElement}
         */
        this.$widget = document.createElement( 'div' );
        this.$widget.classList.add( 'widget' );

        /**
         * The DOM element that receives the disabled attribute when using disable().
         * @type {HTMLElement}
         */
        this.$disable = this.$widget;

        this.domElement.appendChild( this.$name );
        this.domElement.appendChild( this.$widget );

        // Mick: For text inputs, stop propagation so typing works normally.
        // Mick: For non-text controls (checkboxes, selects), blur and preventDefault
        // Mick: so the key event propagates to the document-level handler instead.
        this.domElement.addEventListener( 'keydown', e => {
            const el = document.activeElement;
            if (el) {
                const tag = el.tagName.toLowerCase();
                const type = (el.type || '').toLowerCase();
                if (tag === 'textarea' || (tag === 'input' && (type === 'text' || type === 'number'))) {
                    e.stopPropagation();
                    return;
                }
            }
            el?.blur();
            e.preventDefault();
        } );
        this.domElement.addEventListener( 'keyup', e => {
            const el = e.target;
            const tag = el.tagName.toLowerCase();
            const type = (el.type || '').toLowerCase();
            if (tag === 'textarea' || (tag === 'input' && (type === 'text' || type === 'number'))) {
                e.stopPropagation();
            }
        } );

        this.parent.children.push( this );
        this.parent.controllers.push( this );

        this.parent.$children.appendChild( this.domElement );

//        this._listenCallback = this._listenCallback.bind( this );

        this.name( property );

    }

    /**
     * Sets the name of the controller and its label in the GUI.
     * @param {string} name
     * @returns {this}
     */
    name( name ) {
        /**
         * The controller's name. Use `controller.name( 'Name' )` to modify this value.
         * @type {string}
         */
        this._name = name;
        // SITREC PATCH (security): textContent, not innerHTML. Controller names are
        // routinely built from untrusted data — track names from a loaded KML/CSV, object
        // and graph titles from a sitch loaded via ?custom=<any URL> — so innerHTML here is
        // a DOM XSS sink reachable by anyone who can get a user to click a link. Nothing in
        // Sitrec passes markup to .name(); the only HTML-looking value is the literal
        // "<no desc>" placeholder, which innerHTML silently swallowed as an unknown tag and
        // textContent now renders correctly. Re-apply this when upgrading lil-gui.
        this.$name.textContent = name;
        return this;
    }

    /**
     * Pass a function to be called whenever the value is modified by this controller.
     * The function receives the new value as its first parameter. The value of `this` will be the
     * controller.
     *
     * For function controllers, the `onChange` callback will be fired on click, after the function
     * executes.
     * @param {Function} callback
     * @returns {this}
     * @example
     * const controller = gui.add( object, 'property' );
     *
     * controller.onChange( function( v ) {
     * 	console.log( 'The value is now ' + v );
     * 	console.assert( this === controller );
     * } );
     */
    onChange( callback ) {
        /**
         * Used to access the function bound to `onChange` events. Don't modify this value directly.
         * Use the `controller.onChange( callback )` method instead.
         * @type {Function}
         */
        this._onChange = callback;
        return this;
    }

    /**
     * Calls the onChange methods of this controller and its parent GUI.
     * @protected
     */
    _callOnChange() {

        this.parent._callOnChange( this );

        if ( this._onChange !== undefined ) {
            this._onChange.call( this, this.getValue() );
        }

        // MICK: added this to ensure that the main rendering is called on all UI changes
        // previously this was called every frame, but we don't need that when paused
        // however, we do need it if we've changed something
        setRenderOne(true);


        this._changed = true;

    }

    /**
     * Pass a function to be called after this controller has been modified and loses focus.
     * @param {Function} callback
     * @returns {this}
     * @example
     * const controller = gui.add( object, 'property' );
     *
     * controller.onFinishChange( function( v ) {
     * 	console.log( 'Changes complete: ' + v );
     * 	console.assert( this === controller );
     * } );
     */
    onFinishChange( callback ) {
        /**
         * Used to access the function bound to `onFinishChange` events. Don't modify this value
         * directly. Use the `controller.onFinishChange( callback )` method instead.
         * @type {Function}
         */
        this._onFinishChange = callback;
        return this;
    }

    /**
     * Should be called by Controller when its widgets lose focus.
     * @protected
     */
    _callOnFinishChange() {

        if ( this._changed ) {

            this.parent._callOnFinishChange( this );

            if ( this._onFinishChange !== undefined ) {
                this._onFinishChange.call( this, this.getValue() );
            }

        }

        this._changed = false;

    }

    /**
     * Sets the controller back to its initial value.
     * @returns {this}
     */
    reset() {
        this.setValue( this.initialValue );
        this._callOnFinishChange();
        return this;
    }

    /**
     * Enables this controller.
     * @param {boolean} enabled
     * @returns {this}
     * @example
     * controller.enable();
     * controller.enable( false ); // disable
     * controller.enable( controller._disabled ); // toggle
     */
    enable( enabled = true ) {
        return this.disable( !enabled );
    }

    /**
     * Disables this controller.
     * @param {boolean} disabled
     * @returns {this}
     * @example
     * controller.disable();
     * controller.disable( false ); // enable
     * controller.disable( !controller._disabled ); // toggle
     */
    disable( disabled = true ) {

        if ( disabled === this._disabled ) return this;

        this._disabled = disabled;

        this.domElement.classList.toggle( 'disabled', disabled );
        this.$disable.toggleAttribute( 'disabled', disabled );

        return this;

    }

    /**
     * Shows the Controller after it's been hidden.
     * @param {boolean} show
     * @returns {this}
     * @example
     * controller.show();
     * controller.show( false ); // hide
     * controller.show( controller._hidden ); // toggle
     */
    show( show = true ) {

        this._hidden = !show;

        this.domElement.style.display = this._hidden ? 'none' : '';

        return this;

    }

    /**
     * Hides the Controller.
     * @returns {this}
     */
    hide() {
        return this.show( false );
    }

    /**
     * Changes this controller into a dropdown of options.
     *
     * Calling this method on an option controller will simply update the options. However, if this
     * controller was not already an option controller, old references to this controller are
     * destroyed, and a new controller is added to the end of the GUI.
     * @example
     * // safe usage
     *
     * gui.add( obj, 'prop1' ).options( [ 'a', 'b', 'c' ] );
     * gui.add( obj, 'prop2' ).options( { Big: 10, Small: 1 } );
     * gui.add( obj, 'prop3' );
     *
     * // danger
     *
     * const ctrl1 = gui.add( obj, 'prop1' );
     * gui.add( obj, 'prop2' );
     *
     * // calling options out of order adds a new controller to the end...
     * const ctrl2 = ctrl1.options( [ 'a', 'b', 'c' ] );
     *
     * // ...and ctrl1 now references a controller that doesn't exist
     * assert( ctrl2 !== ctrl1 )
     * @param {object|Array} options
     * @returns {Controller}
     */
    options( options ) {
        const controller = this.parent.add( this.object, this.property, options );
        controller.name( this._name );
        this.destroy();
        return controller;
    }

    /**
     * Sets the minimum value. Only works on number controllers.
     * @param {number} min
     * @returns {this}
     */
    min( min ) {
        return this;
    }

    /**
     * Sets the maximum value. Only works on number controllers.
     * @param {number} max
     * @returns {this}
     */
    max( max ) {
        return this;
    }

    /**
     * Values set by this controller will be rounded to multiples of `step`. Only works on number
     * controllers.
     * @param {number} step
     * @returns {this}
     */
    step( step ) {
        return this;
    }

    /**
     * Rounds the displayed value to a fixed number of decimals, without affecting the actual value
     * like `step()`. Only works on number controllers.
     * @example
     * gui.add( object, 'property' ).listen().decimals( 4 );
     * @param {number} decimals
     * @returns {this}
     */
    decimals( decimals ) {
        return this;
    }


    /**
     * Calls `updateDisplay()` every animation frame. Pass `false` to stop listening.
     * @param {boolean} listen
     * @returns {this}
     */
    listen( listen = true ) {

        /**
         * Used to determine if the controller is currently listening. Don't modify this value
         * directly. Use the `controller.listen( true|false )` method instead.
         * @type {boolean}
         */
        this._listening = listen;

        // MICK: removed the callbacks, as the check is now explict in the main
        // rendering loop calling the new function updateListeners
        // which you call on each root GUI object
        // (i.e. just on "gui" in Sitrec/index.js)
        //
        // if ( this._listenCallbackID !== undefined ) {
        //     cancelAnimationFrame( this._listenCallbackID );
        //     this._listenCallbackID = undefined;
        // }
        //
        // if ( this._listening ) {
        //     this._listenCallback();
        // }

        return this;

    }

    // _listenCallback() {
    //
    //     this._listenCallbackID = requestAnimationFrame( this._listenCallback );
    //
    //     // To prevent framerate loss, make sure the value has changed before updating the display.
    //     // Note: save() is used here instead of getValue() only because of ColorController. The !== operator
    //     // won't work for color objects or arrays, but ColorController.save() always returns a string.
    //
    //     const curValue = this.save();
    //
    //     if ( curValue !== this._listenPrevValue ) {
    //
    //
    //         this.updateDisplay();
    //     }
    //
    //     this._listenPrevValue = curValue;
    //
    // }

    /**
     * Returns `object[ property ]`.
     * @returns {any}
     */
    getValue() {
        return this.object[ this.property ];
    }

    /**
     * Sets the value of `object[ property ]`, invokes any `onChange` handlers and updates the display.
     * @param {any} value
     * @returns {this}
     */
    setValue( value ) {
        this.object[ this.property ] = value;
        this._callOnChange();
        this.updateDisplay();
        return this;
    }

    /**
     * Updates the display to keep it in sync with the current value. Useful for updating your
     * controllers when their values have been modified outside of the GUI.
     * @returns {this}
     */
    updateDisplay() {
        return this;
    }

    load( value ) {
        this.setValue( value );
        this._callOnFinishChange();
        return this;
    }

    save() {
        return this.getValue();
    }

    /**
     * Destroys this controller and removes it from the parent GUI.
     */
    destroy(all = false) {
        if (all || !this.permanent) {
            this.listen(false);
            const childIndex = this.parent.children.indexOf(this);
            const controllerIndex = this.parent.controllers.indexOf(this);
//            console.log("destroying controller, childIndex: " + childIndex + " controllerIndex: " + controllerIndex);
            this.parent.children.splice(childIndex, 1);
            this.parent.controllers.splice(controllerIndex, 1);
            // Remove from actual parent (may differ from expected parent after menu relocation)
            if (this.domElement && this.domElement.parentNode) {
                this.domElement.parentNode.removeChild(this.domElement);
            }
        }
    }

    perm() {
        this.permanent = true;
        return this;
    }

}

class BooleanController extends Controller {

    constructor( parent, object, property ) {

        super( parent, object, property, 'boolean', 'label' );

        this.$input = document.createElement( 'input' );
        this.$input.setAttribute( 'type', 'checkbox' );
        this.$input.setAttribute( 'aria-labelledby', this.$name.id );

        this.$widget.appendChild( this.$input );

        this.$input.addEventListener( 'change', () => {
            this.setValue( this.$input.checked );
            this._callOnFinishChange();
        } );

        this.$disable = this.$input;

        this.updateDisplay();

    }

    updateDisplay() {
        // Skip DOM write when the displayed value is unchanged. .listen()
        // calls updateDisplay every frame; on slower hardware the DOM setter
        // can dominate frame time. See lil-gui-extras.updateListeners.
        const value = this.getValue();
        if ( value !== this._lastDisplayedChecked ) {
            this.$input.checked = value;
            this._lastDisplayedChecked = value;
        }
        return this;
    }

}

function normalizeColorString( string ) {

    let match, result;

    if ( match = string.match( /(#|0x)?([a-f0-9]{6})/i ) ) {

        result = match[ 2 ];

    } else if ( match = string.match( /rgb\(\s*(\d*)\s*,\s*(\d*)\s*,\s*(\d*)\s*\)/ ) ) {

        result = parseInt( match[ 1 ] ).toString( 16 ).padStart( 2, 0 )
            + parseInt( match[ 2 ] ).toString( 16 ).padStart( 2, 0 )
            + parseInt( match[ 3 ] ).toString( 16 ).padStart( 2, 0 );

    } else if ( match = string.match( /^#?([a-f0-9])([a-f0-9])([a-f0-9])$/i ) ) {

        result = match[ 1 ] + match[ 1 ] + match[ 2 ] + match[ 2 ] + match[ 3 ] + match[ 3 ];

    }

    if ( result ) {
        return '#' + result;
    }

    return false;

}

const STRING = {
    isPrimitive: true,
    match: v => typeof v === 'string',
    fromHexString: normalizeColorString,
    toHexString: normalizeColorString
};

const INT = {
    isPrimitive: true,
    match: v => typeof v === 'number',
    fromHexString: string => parseInt( string.substring( 1 ), 16 ),
    toHexString: value => '#' + value.toString( 16 ).padStart( 6, 0 )
};

const ARRAY = {
    isPrimitive: false,

    // The arrow function is here to appease tree shakers like esbuild or webpack.
    // See https://esbuild.github.io/api/#tree-shaking
    match: v => Array.isArray( v ),

    fromHexString( string, target, rgbScale = 1 ) {

        const int = INT.fromHexString( string );

        target[ 0 ] = ( int >> 16 & 255 ) / 255 * rgbScale;
        target[ 1 ] = ( int >> 8 & 255 ) / 255 * rgbScale;
        target[ 2 ] = ( int & 255 ) / 255 * rgbScale;

    },
    toHexString( [ r, g, b ], rgbScale = 1 ) {

        rgbScale = 255 / rgbScale;

        const int = ( r * rgbScale ) << 16 ^
            ( g * rgbScale ) << 8 ^
            ( b * rgbScale ) << 0;

        return INT.toHexString( int );

    }
};

const OBJECT = {
    isPrimitive: false,
    match: v => Object( v ) === v,
    fromHexString( string, target, rgbScale = 1 ) {

        const int = INT.fromHexString( string );

        target.r = ( int >> 16 & 255 ) / 255 * rgbScale;
        target.g = ( int >> 8 & 255 ) / 255 * rgbScale;
        target.b = ( int & 255 ) / 255 * rgbScale;

    },
    toHexString( { r, g, b }, rgbScale = 1 ) {

        rgbScale = 255 / rgbScale;

        const int = ( r * rgbScale ) << 16 ^
            ( g * rgbScale ) << 8 ^
            ( b * rgbScale ) << 0;

        return INT.toHexString( int );

    }
};

const FORMATS = [ STRING, INT, ARRAY, OBJECT ];

function getColorFormat( value ) {
    return FORMATS.find( format => format.match( value ) );
}

class ColorController extends Controller {

    constructor( parent, object, property, rgbScale ) {

        super( parent, object, property, 'color' );

        this.$input = document.createElement( 'input' );
        this.$input.setAttribute( 'type', 'color' );
        this.$input.setAttribute( 'tabindex', -1 );
        this.$input.setAttribute( 'aria-labelledby', this.$name.id );

        this.$text = document.createElement( 'input' );
        this.$text.setAttribute( 'type', 'text' );
        this.$text.setAttribute( 'spellcheck', 'false' );
        this.$text.setAttribute( 'aria-labelledby', this.$name.id );

        this.$display = document.createElement( 'div' );
        this.$display.classList.add( 'display' );

        this.$display.appendChild( this.$input );
        this.$widget.appendChild( this.$display );
        this.$widget.appendChild( this.$text );

        this._format = getColorFormat( this.initialValue );
        this._rgbScale = rgbScale;

        this._initialValueHexString = this.save();
        this._textFocused = false;

        this.$input.addEventListener( 'input', () => {
            this._setValueFromHexString( this.$input.value );
        } );

        this.$input.addEventListener( 'blur', () => {
            this._callOnFinishChange();
        } );

        this.$text.addEventListener( 'input', () => {
            const tryParse = normalizeColorString( this.$text.value );
            if ( tryParse ) {
                this._setValueFromHexString( tryParse );
            }
        } );

        this.$text.addEventListener( 'focus', () => {
            this._textFocused = true;
            this.$text.select();
        } );

        this.$text.addEventListener( 'blur', () => {
            this._textFocused = false;
            this.updateDisplay();
            this._callOnFinishChange();
        } );

        this.$disable = this.$text;

        this.updateDisplay();

    }

    reset() {
        this._setValueFromHexString( this._initialValueHexString );
        return this;
    }

    _setValueFromHexString( value ) {

        if ( this._format.isPrimitive ) {

            const newValue = this._format.fromHexString( value );
            this.setValue( newValue );

        } else {

            this._format.fromHexString( value, this.getValue(), this._rgbScale );
            this._callOnChange();
            this.updateDisplay();

        }

    }

    save() {
        return this._format.toHexString( this.getValue(), this._rgbScale );
    }

    load( value ) {
        this._setValueFromHexString( value );
        this._callOnFinishChange();
        return this;
    }

    updateDisplay() {
        // Skip DOM writes when displayed color is unchanged.
        const hex = this._format.toHexString( this.getValue(), this._rgbScale );
        if ( hex !== this._lastDisplayedHex ) {
            this.$input.value = hex;
            if ( !this._textFocused ) {
                this.$text.value = hex.substring( 1 );
            }
            this.$display.style.backgroundColor = hex;
            this._lastDisplayedHex = hex;
        }
        return this;
    }

}

class FunctionController extends Controller {

    constructor( parent, object, property ) {

        super( parent, object, property, 'function' );

        // Buttons are the only case where widget contains name
        this.$button = document.createElement( 'button' );
        this.$button.appendChild( this.$name );
        this.$widget.appendChild( this.$button );

        this.$button.addEventListener( 'click', e => {
            e.preventDefault();
            this.getValue().call( this.object );
            this._callOnChange();
        } );

        // enables :active pseudo class on mobile
        this.$button.addEventListener( 'touchstart', () => {}, { passive: true } );

        this.$disable = this.$button;

    }

}

class NumberController extends Controller {

    constructor( parent, object, property, min, max, step, snap = true) {

        super( parent, object, property, 'number' );

        this._initInput();

        this.min( min );
        this.max( max );

        assert( step !== undefined, "NumberController requires a step value, deprecated the old explicit step logic" );

        //const stepExplicit = step !== undefined;
        //this.step( stepExplicit ? step : this._getImplicitStep(), stepExplicit );
        this.step( step );
        this.snap( snap );

        this.updateDisplay();

    }

    // number of decimal places to show
    decimals( decimals ) {
        this._decimals = decimals;
        this.updateDisplay();
        return this;
    }

    // value represened by the slider at 0%
    min( min ) {
        if (this._originalMin === undefined) {
            this._originalMin = min;
        }
        this._min = min;
        this._onUpdateMinMax();
        return this;
    }

    // value represented by the slider at 100%
    max( max ) {
        if (this._originalMax === undefined) {
            this._originalMax = max;
        }
        this._max = max;
        this._onUpdateMinMax();
        return this;
    }

    // Allow direct text entry to expand max instead of clamping to the current slider max.
    allowInputExpandMax( allow = true ) {
        this._allowInputExpandMax = allow;
        return this;
    }

    // MICK: the mirror of allowInputExpandMax - a typed value BELOW the current min
    // lowers the min instead of being clamped up to it. `limit` is a hard floor: a
    // value under it is clamped as usual rather than expanding the range, so a slip
    // like "18" in a year field cannot drag the slider somewhere nonsensical.
    allowInputExpandMin( allow = true, limit = -Infinity ) {
        this._allowInputExpandMin = allow;
        this._inputExpandMinLimit = limit;
        return this;
    }

    // step size for each increment/decrement with the arrow keys, draggin number up/down or mouse wheel
    step( step, explicit = true ) {
        this._step = step;
        //this._stepExplicit = explicit;
        return this;
    }

    snap(v) {
        this._doSnap = v;
        return this;
    }


    // MICK: added wrapping and elastic sliders
    // wrapping will wrap the value around the min/max
    // and add (or subtract) 1 to the wrapReceiver
    // this allows you to have, say a slider for hours in a day and the next for minutes in the hour
    // then wrapping the minutes slider will increment/decrement the hours slider
    wrap( wrapReceiver ) {
        this._canWrap = true;
        this._wrapReceiver = wrapReceiver;
        return this;
    }

    // MICK: override the wrap period used by the step-based wrap (arrow keys, wheel).
    // It defaults to max-min+step, which is right for the INTEGER date/time sliders
    // where the two endpoints are distinct values one step apart (0-59 minutes). On a
    // continuous circular slider the endpoints are the SAME value - an angle slider
    // spanning 0..360 has one direction at both ends, not two - so stepping off the
    // end with the +step period lands one step short and appears to stick. Such a
    // slider passes its true period (360) here.
    wrapPeriod( period ) {
        this._wrapPeriod = period;
        return this;
    }

    // elastic will expand or contract the range if you push against the min or max
    // this allows finer control
    elastic( min = 100, max = 1000000, integer = false, shrink = false ) {
        this._elastic = true;
        this._elasticMin = min;
        this._elasticMax = max;
        this._elasticInteger = integer;
        this._elasticShrink = shrink;
        this.updateElasticStep();
        return this;
    }

    // the eleastic step is 0.2% of the range
    // it's recalcuclated on min/max changes (assuming elastic is on)
    updateElasticStep() {
        if (this._elastic) {

            let bottom = this._min;
            if (this._min < this._max/4) {
                bottom = 0;
            }

            // just set it to 0.2% of the range
            this._step = (this._max - bottom) / 500;
            if (this._elasticInteger) {
                this._step = Math.max(1,Math.round(this._step));
            }

            // Why not this?
            if (this._step > 1) {
                this._step = 1;
            }

        }
        return this;
    }

    // MICK: how far along the track the knob sits, 0..1. It reads the RAW stored
    // value rather than getValue(): a log slider keeps log10(value) in the object,
    // and its _min/_max are in that same log space, so this is the one formula that
    // is right for both kinds. Also used by the big-slider popup to draw its fill.
    _fillPercent() {
        const raw = this.object[ this.property ];
        const percent = ( raw - this._min ) / ( this._max - this._min );
        return Math.max( 0, Math.min( percent, 1 ) );
    }

    // MICK: the value as the input box shows it. Shared with the big-slider popup's
    // read-out, so the two can never disagree about decimals or the log/zero rules.
    displayText() {
        const value = this.getValue();  // log sliders return the real (exponentiated) value
        if ( this._displayZeroThreshold !== undefined && value <= this._displayZeroThreshold ) {
            return '0';
        }
        return this._decimals === undefined ? String( value ) : value.toFixed( this._decimals );
    }

    // given the value (in the object, not the GUI), update the display of the slider line and the input box
    updateDisplay() {

        // Mick: checking $fill instead of $_hasSlider as we set $_hasSlider to true to prevent recreation after removing the DOM element it with noSloder()
        if ( this.$fill ) {

            const percent = this._fillPercent();

            // Skip layout-triggering style write when width is unchanged.
            // .listen() runs this every frame; on slow GPUs the style setter
            // is a major frame-time cost.
            if ( percent !== this._lastDisplayedPercent ) {
                this.$fill.style.width = percent * 100 + '%';
                this._lastDisplayedPercent = percent;
            }

        }

        if ( !this._inputFocused ) {
            const text = this.displayText();
            if ( text !== this._lastDisplayedText ) {
                this.$input.value = text;
                this._lastDisplayedText = text;
            }
        }

        return this;

    }

    _initInput() {

        // this.$input is the text input box for direct number entry
        // (and displaying what the current value is when modifeid by the slider or externally)
        this.$input = document.createElement( 'input' );
        this.$input.setAttribute( 'type', 'text' );
        this.$input.setAttribute( 'aria-labelledby', this.$name.id );

        // On touch devices only, use input[type=number] to force a numeric keyboard.
        // Ideally we could use one input type everywhere, but [type=number] has quirks
        // on desktop, and [inputmode=decimal] has quirks on iOS.
        // See https://github.com/georgealways/lil-gui/pull/16

        const isTouch = window.matchMedia( '(pointer: coarse)' ).matches;

        if ( isTouch ) {
            this.$input.setAttribute( 'type', 'number' );
            this.$input.setAttribute( 'step', 'any' );
        }

        this.$widget.appendChild( this.$input );

        this.$disable = this.$input;

        // now there's several event handlers which change the number in various ways

        // onInput: when the user types in a number
        // ---------------------------------------------------------------------
        const onInput = () => {

            let value = parseFloat( this.$input.value );

            if ( isNaN( value ) ) return;

            // MICK: For log sliders, the typed value is the displayed (exponential) value
            // Convert it to log10 for the underlying stored value
            if ( this._isLog ) {
                value = Math.max( value, 1e-10 ); // Prevent log of zero/negative
                value = Math.log10( value );
            }

            // now never snap on text input, it's too confusing
            // if the user enterd a number, they want that number
            // if ( this._doSnap ) {
            //     value = this._snap( value );
            // }

            if ( this._elastic ) {
                if ( value > this._elasticMax ) {
                    this._elasticMax = value;
                }
                while ( value > this._max && this._max < this._elasticMax ) {
                    this._max = Math.min( this._max * 2, this._elasticMax );
                    this.updateElasticStep();
                }
                this.setValue( value );
            } else {
                if ( this._allowInputExpandMax && this._max !== undefined && value > this._max ) {
                    this._max = value;
                    this._onUpdateMinMax();
                }
                if ( this._allowInputExpandMin && this._min !== undefined
                     && value < this._min && value >= this._inputExpandMinLimit ) {
                    this._min = value;
                    this._onUpdateMinMax();
                }
                this.setValue( this._clamp( value ) );
            }

        };

        // Keys & mouse wheel
        // ---------------------------------------------------------------------

        // helper function to increment/decrement the value by the current step
        const increment = delta => {

            const value = parseFloat( this.$input.value );

            if ( isNaN( value ) ) return;

            // MICK: wrapping sliders wrap on arrow keys / wheel too, not just drag
            this._snapWrapSetValue( value + delta );

            // Force the input to updateDisplay when it's focused
            this.$input.value = this.getValue();

        };

        const onKeyDown = e => {
            // Using `e.key` instead of `e.code` also catches NumpadEnter
            if ( e.key === 'Enter' ) {
                this.$input.blur();
            }
            if ( e.code === 'ArrowUp' ) {
                e.preventDefault();
                increment( this._step * this._arrowKeyMultiplier( e ) );
            }
            if ( e.code === 'ArrowDown' ) {
                e.preventDefault();
                increment( this._step * this._arrowKeyMultiplier( e ) * -1 );
            }
        };

        const onWheel = e => {
            if ( this._inputFocused ) {
                e.preventDefault();
                e.stopPropagation();
                increment( this._step * this._normalizeMouseWheel( e ) );
            }
        };

        // Vertical drag
        // ---------------------------------------------------------------------

        let testingForVerticalDrag = false,
            initClientX,
            initClientY,
            prevClientY,
            prevClientX,
            initValue,
            dragDelta;

        // Once the mouse is dragged more than DRAG_THRESH px on any axis, we decide
        // on the user's intent: horizontal means highlight, vertical means drag.
        const DRAG_THRESH = 5;

        const onMouseDown = e => {
            if (e.button === 2) return; // right-click opens context menu, not drag

            initClientX = prevClientX = e.clientX;
            initClientY = prevClientY = e.clientY;
            testingForVerticalDrag = true;

            initValue = this.getValue();
            dragDelta = 0;

            window.addEventListener( 'mousemove', onMouseMove );
            window.addEventListener( 'mouseup', onMouseUp );

        };

        const onMouseMove = e => {

            if ( testingForVerticalDrag ) {

                const dx = e.clientX - initClientX;
                const dy = e.clientY - initClientY;

                if ( Math.abs( dy ) > DRAG_THRESH ) {

                    e.preventDefault();
                    this.$input.blur();
                    testingForVerticalDrag = false;
                    this._setDraggingStyle( true, 'vertical' );

                } else if ( Math.abs( dx ) > DRAG_THRESH ) {

                    onMouseUp();

                }

            }

            // This isn't an else so that the first move counts towards dragDelta
            if ( !testingForVerticalDrag ) {

                const dy = e.clientY - prevClientY;

                dragDelta -= dy * this._step * this._arrowKeyMultiplier( e );

                // Clamp dragDelta so we don't have 'dead space' after dragging past bounds.
                // We're okay with the fact that bounds can be undefined here.
                if ( initValue + dragDelta > this._max ) {
                    dragDelta = this._max - initValue;
                } else if ( initValue + dragDelta < this._min ) {
                    dragDelta = this._min - initValue;
                }

                this._snapClampSetValue( initValue + dragDelta );

            }

            prevClientY = e.clientY;
            prevClientX = e.clientX;

        };

        const onMouseUp = () => {
            this._setDraggingStyle( false, 'vertical' );
            this._callOnFinishChange();
            window.removeEventListener( 'mousemove', onMouseMove );
            window.removeEventListener( 'mouseup', onMouseUp );
        };

        // Focus state & onFinishChange
        // ---------------------------------------------------------------------

        const onFocus = () => {
            this._inputFocused = true;
        };

        const onBlur = () => {
            this._inputFocused = false;
            this.updateDisplay();
            this._callOnFinishChange();
        };

        this.$input.addEventListener( 'input', onInput );
        this.$input.addEventListener( 'keydown', onKeyDown );
        this.$input.addEventListener( 'wheel', onWheel, { passive: false } );
        this.$input.addEventListener( 'mousedown', onMouseDown );
        this.$input.addEventListener( 'focus', onFocus );
        this.$input.addEventListener( 'blur', onBlur );

    }

    _initSlider() {

        this._hasSlider = true;

        // Build DOM
        // ---------------------------------------------------------------------

        this.$slider = document.createElement( 'div' );
        this.$slider.classList.add( 'slider' );

        this.$fill = document.createElement( 'div' );
        this.$fill.classList.add( 'fill' );

        this.$slider.appendChild( this.$fill );
        this.$widget.insertBefore( this.$slider, this.$input );

        this.domElement.classList.add( 'hasSlider' );

        // Map clientX to value
        // ---------------------------------------------------------------------

        // MICK: the mapping itself, and the drag bookkeeping around it, live on the
        // prototype (_setValueFromX / _dragStart / _dragMove) so that the big-slider
        // popup can steer this controller through exactly the same maths - elastic,
        // wrapping and all - just by handing them its own full-width track element.

        // Mouse drag
        // ---------------------------------------------------------------------

        // MICK: the drag takes a pointer capture, so it keeps tracking after the pointer
        // leaves the slider, and after it leaves the browser window.
        // It is still bounded by the edge of the screen: once the OS pins the cursor
        // there clientX stops changing and a wrapping slider stops wrapping. The only way
        // to get past that is the Pointer Lock API, and Chrome answers every lock outside
        // fullscreen with a "to show your cursor press Esc" bubble that cannot be
        // suppressed by the page - too intrusive for a slider drag, so we don't use it.

        let dragging = false;
        let dragPointerId = null;
        let touchDragging = false;

        const pointerDown = e => {
            if (e.button === 2) return;
            // Touch goes through the touchstart path below - that is the one that can
            // tell a slide from a scroll, and committing a value here on touch-down
            // would move the slider under anyone trying to scroll the menu.
            if (e.pointerType === 'touch') return;
            // One drag at a time. Without this a second pen or mouse landing on the
            // slider would take over dragPointerId, killing the drag already in
            // progress - the move/up guards below only reject a stray move or release,
            // they cannot tell a hijacking press from a legitimate one.
            if (dragging || touchDragging) return;

            // Claim the drag and register its cleanup FIRST. Everything below can fail:
            // setValueFromX() runs the controller's onChange, which may rebuild the menu
            // out from under this slider, or simply throw. If that happened before the
            // listeners were in place, the lil-gui-dragging class would be left on
            // document.body with nothing able to take it off again, and this controller
            // would refuse every future drag.
            dragging = true;
            dragPointerId = e.pointerId;
            this.$slider.addEventListener( 'pointermove', pointerMove );
            this.$slider.addEventListener( 'pointerup', pointerUp );
            this.$slider.addEventListener( 'pointercancel', pointerUp );

            // Those listeners live on the slider, so if it is taken out of the DOM
            // mid-drag they stop firing and nothing ever ends the drag. Measured in
            // Chrome: on removal the lostpointercapture is dispatched where only a
            // document-level listener sees it (the element's own does not fire), and the
            // eventual pointerup still reaches the window. Use both as the safety net.
            // All three in the CAPTURE phase: a bubble-phase pointerup handler elsewhere
            // in the page may call stopPropagation (Chart3D and the script timeline both
            // do), which would keep a bubble-phase backstop from ever running.
            document.addEventListener( 'lostpointercapture', pointerUp, true );
            window.addEventListener( 'pointerup', pointerUp, true );
            window.addEventListener( 'pointercancel', pointerUp, true );

            // Capture throws if the slider is not in the document. Its bounding rect
            // would then be all zeros, and setValueFromX() would map the press to an
            // endpoint or NaN, so give up on the drag rather than corrupt the value.
            try {
                this.$slider.setPointerCapture( e.pointerId );
            } catch ( err ) {
                endDrag();
                return;
            }

            this._setDraggingStyle( true );
            this._dragStart( e.clientX );
        };

        // Only the pointer that started the drag may steer or end it. The listeners sit
        // on the slider, so a second pointer over it - a finger on a touchscreen, a pen -
        // would otherwise yank the value to its own X, or release the drag early.
        const pointerMove = e => {
            if ( e.pointerId !== dragPointerId ) return;
            this._dragMove( e.clientX );
        };

        // Tear the drag down completely. Kept separate from onFinishChange so that the
        // user callback runs last: if it throws, the listeners and the global
        // lil-gui-dragging class are already gone rather than stranded.
        const endDrag = () => {
            dragging = false;
            this._setDraggingStyle( false );

            this.$slider.removeEventListener( 'pointermove', pointerMove );
            this.$slider.removeEventListener( 'pointerup', pointerUp );
            this.$slider.removeEventListener( 'pointercancel', pointerUp );
            // removed before releasing the capture, so the release cannot re-enter here
            document.removeEventListener( 'lostpointercapture', pointerUp, true );
            window.removeEventListener( 'pointerup', pointerUp, true );
            window.removeEventListener( 'pointercancel', pointerUp, true );

            if ( dragPointerId !== null && this.$slider.hasPointerCapture( dragPointerId ) ) {
                this.$slider.releasePointerCapture( dragPointerId );
            }
            dragPointerId = null;
        };

        const pointerUp = e => {
            if ( !dragging || e.pointerId !== dragPointerId ) return;
            endDrag();
            this._callOnFinishChange();
        };

        // Touch drag
        // ---------------------------------------------------------------------

        let testingForScroll = false, prevClientX, prevClientY;
        let touchDragId = null;

        // MICK: the drag belongs to the one contact that started it. The handlers are on
        // the window and see every finger, so without this a second finger's move would
        // steer the slider, and its release would end the drag early.
        const findDragTouch = list => {
            for ( let i = 0; i < list.length; i++ ) {
                if ( list[ i ].identifier === touchDragId ) return list[ i ];
            }
            return null;
        };

        const beginTouchDrag = ( e, touch ) => {
            e.preventDefault();
            this._setDraggingStyle( true );

            // MICK: measure from the drag origin seeded in onTouchStart, not from here.
            // In a scrollable container this runs on the FIRST touchmove, after the
            // scroll/slide test - so the finger has already travelled, and that first
            // step has to carry the wrapReceiver like any other.
            this._dragMove( touch.clientX );
            testingForScroll = false;
        };

        const onTouchStart = e => {

            if ( e.touches.length > 1 ) return;
            // MICK: the touch path shares prevDragX/deltaX and the value itself with the
            // pointer path, so a finger landing mid pointer-drag would move the origin
            // out from under it. One drag at a time here too.
            if ( dragging || touchDragging ) return;
            touchDragging = true;
            touchDragId = e.touches[ 0 ].identifier;

            // MICK: registered up front, before anything that can throw - see pointerDown.
            // beginTouchDrag() below runs the controller's onChange, and if that threw
            // with no touchend listener yet installed, touchDragging and the body's
            // lil-gui-dragging class would both be stranded for good.
            // touchcancel is here because a cancelled touch (system gesture, incoming
            // call, palm rejection) never sends touchend.
            window.addEventListener( 'touchmove', onTouchMove, { passive: false } );
            window.addEventListener( 'touchend', onTouchEnd );
            window.addEventListener( 'touchcancel', onTouchEnd );

            // MICK: seed the drag origin at finger-down (min/maxClick for the elastic
            // range, prevDragX/deltaX for the wrap carry - which would otherwise still
            // hold the last mouse drag's value and let a touch invent a carry it never
            // made). Unlike the mouse, no value is committed yet: that waits for the
            // scroll/slide test below.
            prevClientX = e.touches[ 0 ].clientX;
            prevClientY = e.touches[ 0 ].clientY;
            this._dragSeed( prevClientX );

            // If we're in a scrollable container, we should wait for the first
            // touchmove to see if the user is trying to slide or scroll.
            if ( this._hasScrollBar ) {

                testingForScroll = true;

            } else {

                // Otherwise, we can set the value straight away on touchstart.
                beginTouchDrag( e, e.touches[ 0 ] );

            }

        };

        const onTouchMove = e => {

            // Only the contact that started the drag may move it - and only on the events
            // where it is the one that actually moved, hence changedTouches rather than
            // touches. A second finger moving while ours is still would otherwise be read
            // as our finger reporting no motion at all: dx === dy === 0 fails the test
            // below and aborts a drag that never got the chance to start.
            const touch = findDragTouch( e.changedTouches );
            if ( !touch ) return;

            if ( testingForScroll ) {

                const dx = touch.clientX - prevClientX;
                const dy = touch.clientY - prevClientY;

                if ( Math.abs( dx ) > Math.abs( dy ) ) {

                    // We moved horizontally, set the value and stop checking.
                    beginTouchDrag( e, touch );

                } else {

                    // This was, in fact, an attempt to scroll. Abort.
                    endTouchDrag();

                }

            } else {

                e.preventDefault();
                // MICK: _dragMove tracks deltaX, so the wrap carry works on touch too
                this._dragMove( touch.clientX );

            }

        };

        // As with endDrag() above: unhook everything first, so a throwing onFinishChange
        // cannot leave the touch listeners or the body's drag class behind.
        const endTouchDrag = () => {
            touchDragging = false;
            touchDragId = null;
            testingForScroll = false;
            this._setDraggingStyle( false );
            window.removeEventListener( 'touchmove', onTouchMove );
            window.removeEventListener( 'touchend', onTouchEnd );
            window.removeEventListener( 'touchcancel', onTouchEnd );
        };

        const onTouchEnd = e => {
            // another finger lifting is not the end of our drag
            if ( e && !findDragTouch( e.changedTouches ) ) return;

            endTouchDrag();
            this._callOnFinishChange();
        };

        // Mouse wheel
        // ---------------------------------------------------------------------

        // We have to use a debounced function to call onFinishChange because
        // there's no way to tell when the user is "done" mouse-wheeling.
        const callOnFinishChange = this._callOnFinishChange.bind( this );
        const WHEEL_DEBOUNCE_TIME = 400;
        let wheelFinishChangeTimeout;

        const onWheel = e => {

            // ignore vertical wheels if there's a scrollbar
            const isVertical = Math.abs( e.deltaX ) < Math.abs( e.deltaY );
            if ( isVertical && this._hasScrollBar ) return;

            e.preventDefault();
            e.stopPropagation();

            // set value
            const delta = this._normalizeMouseWheel( e ) * this._step;
            this._snapClampSetValue( this.getValue() + delta );

            // force the input to updateDisplay when it's focused
            this.$input.value = this.getValue();

            // debounce onFinishChange
            clearTimeout( wheelFinishChangeTimeout );
            wheelFinishChangeTimeout = setTimeout( callOnFinishChange, WHEEL_DEBOUNCE_TIME );

        };

        this.$slider.addEventListener( 'pointerdown', pointerDown );
        this.$slider.addEventListener( 'touchstart', onTouchStart, { passive: false } );
        this.$slider.addEventListener( 'wheel', onWheel, { passive: false } );

    }

    // MICK: map a pointer X onto the slider's range and commit the value. Pulled out
    // of _initSlider's drag closure so a second widget can drive this controller
    // through the identical maths. `trackElement` is whatever the user has hold of:
    // the controller's own $slider normally, the big-slider popup's full-width bar
    // when that is open. Everything below - elastic expansion, wrapping, the
    // wrapReceiver carry - is measured against that element's rect.
    //
    // `allowElasticRange` turns off the pointer-distance elastic rule below. The
    // big-slider popup passes false and resizes the range from its own end zones
    // instead - see _elasticStepRange for why distance cannot do that job on a bar
    // as wide as the window.
    _setValueFromX( clientX, allowWrapping = true, trackElement = this.$slider, allowElasticRange = true ) {

        const map = ( v, a, b, c, d ) => {
            return ( v - a ) / ( b - a ) * ( d - c ) + c;
        };

        const rect = trackElement.getBoundingClientRect();
        const sliderWidth = rect.right - rect.left;

        // MICK: To support elastic sliders, we need to expand the range
        // but the value should be calculated based on the original range
        // when clicked
        let value = map(clientX, rect.left, rect.right, this._minClick, this._maxClick);

        // MICK: added elastic and wrapping
        if (this._elastic && allowElasticRange) {
            assert(!this._canWrap, "elastic and wrap are mutually exclusive");

            // gone off the right, so expand the range to encompass this
            while (value > this._max && this._max < this._elasticMax) {
                this._max = Math.min(this._max * 2, this._elasticMax);
                this.updateElasticStep()
            }

            // off the left, compress the max range?
            // (_elasticMin is the minimum of _max, not _min)
            if (clientX < rect.left) {
                this._max = Math.max(this._max / 2, this._elasticMin);

                // need to reset _maxClick to the new max
                // so if we drag back to the right, we don't jump
                this._maxClick = this._max;
                this.updateElasticStep();
             //   value = this._min;
            }

            if (this._elasticShrink) {

                if (value < this._max/3) {
                    this._max = Math.max(this._max / 2, this._elasticMin+1);
                }
            }

        }

        if (allowWrapping && this._canWrap) {
            if (clientX < rect.left) {
                value = this._max - ((rect.left - clientX) % sliderWidth) / sliderWidth * (this._max - this._min);
            } else if (clientX > rect.right) {
                value = this._min + ((clientX - rect.right) % sliderWidth) / sliderWidth * (this._max - this._min);
            }
        }
        this._snapClampSetValue(value);

        if (allowWrapping && this._canWrap && this._wrapReceiver && Number.isFinite(this.deltaX)) {
            // MICK: count how many whole slider widths this move crossed, and carry
            // all of them into the wrapReceiver (e.g. seconds -> minutes).
            // A single move can cross the end of the slider more than once - a fast
            // flick, or a pointermove the browser has coalesced. Carrying only +/-1
            // in that case leaves the minutes running behind the seconds.
            //
            // wrapIndex() deliberately mirrors the branch tests above, so it steps at
            // exactly the X values where the mapped value jumps. In particular the
            // ends are inclusive: at clientX === rect.right the value is still an
            // un-wrapped _max, so that must be index 0, not 1.
            const wrapIndex = x => {
                if (x > rect.right) return Math.floor((x - rect.right) / sliderWidth) + 1;
                if (x < rect.left) return -(Math.floor((rect.left - x) / sliderWidth) + 1);
                return 0;
            };
            const carry = wrapIndex(clientX) - wrapIndex(clientX - this.deltaX);

            if (carry !== 0) {
                this._wrapReceiver.setValue(this._wrapReceiver.getValue() + carry);
            }
        }

    }

    // MICK: remember where a drag started. The elastic range is frozen at press time
    // (_minClick/_maxClick) so the value does not jump as the range grows under it,
    // and the wrap carry needs an origin to measure deltaX from.
    _dragSeed( clientX ) {
        this._minClick = this._min;
        this._maxClick = this._max;
        this.prevDragX = clientX;
        this.deltaX = 0;
    }

    // MICK: press. No wrapping on the initial click - clicking outside the track
    // should clamp to the near end, not teleport to the far one.
    _dragStart( clientX, trackElement, allowElasticRange = true ) {
        this._dragSeed( clientX );
        this._setValueFromX( clientX, false, trackElement, allowElasticRange );
    }

    // MICK: subsequent moves in a drag that _dragStart (or the touch seed) opened.
    _dragMove( clientX, trackElement, allowElasticRange = true ) {
        this.deltaX = clientX - this.prevDragX;
        this.prevDragX = clientX;
        this._setValueFromX( clientX, true, trackElement, allowElasticRange );
    }

    // MICK: take one elastic step - double _max, or halve it - with no pointer
    // position involved at all.
    //
    // The rule in _setValueFromX only grows the range once the pointer is PAST the
    // end of the track, so what really sets the ceiling is "how much screen is there
    // beyond this slider". A menu slider is about 80px wide with sixteen track widths
    // of room to its right, so it can double its way to _elasticMax. The big-slider
    // popup is a bar as wide as the window with a ~48px gutter, which buys exactly one
    // doubling and then stops. The popup therefore passes allowElasticRange = false
    // and calls this on a timer while the pointer rests in one of its end zones.
    //
    // _maxClick is re-seeded because the rest of the drag maps the pointer onto the
    // range frozen at press time; leaving it stale would make the new headroom
    // unreachable. Returns false when the range is already hard against _elasticMin
    // or _elasticMax, which is how a caller knows there is nothing more to give.
    _elasticStepRange( grow ) {
        if ( !this._elastic ) return false;

        const before = this._max;
        this._max = grow
            ? Math.min( this._max * 2, this._elasticMax )
            : Math.max( this._max / 2, this._elasticMin );
        if ( this._max === before ) return false;

        this._maxClick = this._max;
        this.updateElasticStep();
        return true;
    }

    _setDraggingStyle( active, axis = 'horizontal' ) {
        if ( this.$slider ) {
            this.$slider.classList.toggle( 'active', active );
        }
        document.body.classList.toggle( 'lil-gui-dragging', active );
        document.body.classList.toggle( `lil-gui-${axis}`, active );
    }

    _getImplicitStep() {

        if ( this._hasMin && this._hasMax ) {
            return ( this._max - this._min ) / 1000;
        }

        return 0.1;

    }

    _onUpdateMinMax() {

        if ( !this._hasSlider && this._hasMin && this._hasMax ) {

            // If this is the first time we're hearing about min and max
            // and we haven't explicitly stated what our step is, let's
            // update that too.
            // DEPRECATED
            // if ( !this._stepExplicit ) {
            //     this.step( this._getImplicitStep(), false );
            // }

            this._initSlider();
            this.updateDisplay();

        }

    }

    noSlider() {
        if (this.$slider) {
            this.$slider.remove();
            this.$slider = undefined;
            this.$fill = undefined;
            this.domElement.classList.remove('hasSlider');
        }
        this._hasSlider = true;
        return this;
    }

    _normalizeMouseWheel( e ) {

        let { deltaX, deltaY } = e;

        // Safari and Chrome report weird non-integral values for a notched wheel,
        // but still expose actual lines scrolled via wheelDelta. Notched wheels
        // should behave the same way as arrow keys.
        if ( Math.floor( e.deltaY ) !== e.deltaY && e.wheelDelta ) {
            deltaX = 0;
            deltaY = -e.wheelDelta / 120;
            //deltaY *= this._stepExplicit ? 1 : 10;
        }

        const wheel = deltaX + -deltaY;

        return wheel;

    }

    _arrowKeyMultiplier( e ) {

        //let mult = this._stepExplicit ? 1 : 10;
        let mult = 1;

        // MICK: changed to make shift for fine control
        // and removed alt for medium control (as it does not work on some keyboards)
        if ( e.shiftKey ) {
            mult /= 100;
        }
        // else if ( e.altKey ) {
        //     mult /= 10;
        // }

        return mult;

    }

    _snap( value ) {

        if (!this._doSnap)
            return value;
        // This would be the logical way to do things, but floating point errors.
        // return Math.round( value / this._step ) * this._step;

        // Using inverse step solves a lot of them, but not all
        // const inverseStep = 1 / this._step;
        // return Math.round( value * inverseStep ) / inverseStep;

        // Not happy about this, but haven't seen it break.
        const r = Math.round( value / this._step ) * this._step;
        return parseFloat( r.toPrecision( 15 ) );

    }

    _clamp( value ) {
        // either condition is false if min or max is undefined
        if ( value < this._min ) value = this._min;
        if ( value > this._max ) value = this._max;

        // also clamp for small FP errors
        // basically if there's a number like
        // 0.006800000000000002
        // or 0.6000999999999996
        // then we want to clamp it to 0.0068 or 0.6001 respectively
        // This still seems to cause issue with runaway precisions
        // so still might want to snap to maybe 6 decimal places?
        value = cleanFloat(value);


        // if ( value < this._min ) {
        //     value = this._max;
        //
        //
        // }
        // if ( value > this._max ) value = this._min;

        return value;
    }

    _snapClampSetValue( value ) {
        const snapped = this._snap( value );
        const clamped = this._clamp( snapped );
        this.setValue(clamped)
    }

    // MICK: step-based counterpart of the drag wrapping in setValueFromX.
    // On a wrapping slider, a step past min/max wraps around to the other end
    // and carries +/-1 into the wrapReceiver (e.g. 59->0 minutes bumps hours).
    // The wrap period is max-min+step so the two endpoints are one step apart,
    // matching the integer date/time sliders (0-59, 1-31, etc.)
    _snapWrapSetValue( value ) {
        if ( this._canWrap && this._hasMin && this._hasMax ) {
            const range = this._wrapPeriod ?? ( this._max - this._min + this._step );
            let carry = 0;
            if ( range > 0 ) {
                while ( value > this._max ) { value -= range; carry++; }
                while ( value < this._min ) { value += range; carry--; }
            }
            this._snapClampSetValue( value );
            if ( carry !== 0 && this._wrapReceiver ) {
                this._wrapReceiver.setValue( this._wrapReceiver.getValue() + carry );
            }
        } else {
            this._snapClampSetValue( value );
        }
    }

    get _hasScrollBar() {
        const root = this.parent.root.$children;
        return root.scrollHeight > root.clientHeight;
    }

    get _hasMin() {
        return this._min !== undefined;
    }

    get _hasMax() {
        return this._max !== undefined;
    }

}

class OptionController extends Controller {

    constructor( parent, object, property, options ) {

        super( parent, object, property, 'option' );

        this.$select = document.createElement( 'select' );
        this.$select.setAttribute( 'aria-labelledby', this.$name.id );

        this.$display = document.createElement( 'div' );
        this.$display.classList.add( 'display' );

        this.$select.addEventListener( 'change', () => {
            this.setValue( this._values[ this.$select.selectedIndex ] );
            this._callOnFinishChange();
        } );

        this.$select.addEventListener( 'focus', () => {
            this.$display.classList.add( 'focus' );
        } );

        this.$select.addEventListener( 'blur', () => {
            this.$display.classList.remove( 'focus' );
        } );

        this.$widget.appendChild( this.$select );
        this.$widget.appendChild( this.$display );

        this.$disable = this.$select;

        this.options( options );

    }

    options( options ) {

        // MICK: patch to create two arrays if an array is passed in
        // this normalizes the process of adding and removing options
        // see addOptionToGUIMenu in lil-gui-extras
        // (Original)
        // this._values = Array.isArray( options ) ? options : Object.values( options );
        // this._names = Array.isArray( options ) ? options : Object.keys( options );
        // (new)
        this._values = Array.isArray( options ) ? [...options] : Object.values( options );
        this._names = Array.isArray( options ) ? [...options] : Object.keys( options );
        // END MICK

        this.$select.replaceChildren();

        // MICK Create and append the default option
        if (this.object[this.property] === "-Select-") {
            const $defaultOption = document.createElement('option');
            $defaultOption.innerHTML = 'Select an option';
            $defaultOption.value = '';
            $defaultOption.disabled = true;
            $defaultOption.selected = false;
            this.$select.appendChild($defaultOption);

            // add a dummy value to the start of the _values array
            // so the indexing is correct
            this._values.unshift('DUMMYVALUE');

        }

        this._names.forEach( name => {
            const $option = document.createElement( 'option' );
            // SITREC PATCH (security): textContent, not innerHTML — see the note in name().
            // Dropdown option labels are data-derived (e.g. per-track and per-object lists
            // built from loaded files). Re-apply this when upgrading lil-gui.
            $option.textContent = name;
            this.$select.appendChild( $option );
        } );

        // SITREC PATCH (correctness): invalidate the display cache before repainting.
        //
        // updateDisplay() below repaints only when the VALUE changed, but options() has
        // just changed the NAMES. Replacing the list while the value stays put — a dropdown
        // created with a placeholder such as {"Loading...": ""} and filled in once its
        // contents are known, with "" still selected — left the placeholder on screen for
        // ever: the select and _names were correct, only $display was stale.
        //
        // NaN is never equal to anything, including itself, so the guard cannot match and
        // the repaint always happens. Re-apply this when upgrading lil-gui.
        this._lastDisplayedValue = NaN;

        this.updateDisplay();

        return this;

    }

    updateDisplay() {
        const value = this.getValue();
        if ( value !== this._lastDisplayedValue ) {
            const index = this._values.indexOf( value );
            this.$select.selectedIndex = index;
            // SITREC PATCH (security): textContent, not innerHTML — see the note in name().
            // Both branches are attacker-reachable: `value` is the raw selected value and
            // `_names[]` are data-derived labels. Re-apply this when upgrading lil-gui.
            this.$display.textContent = index === -1 ? value : this._names[ index ];
            this._lastDisplayedValue = value;
        }
        return this;
    }

}

class StringController extends Controller {

    constructor( parent, object, property ) {

        super( parent, object, property, 'string' );

        this.$input = document.createElement( 'input' );
        this.$input.setAttribute( 'type', 'text' );
        this.$input.setAttribute( 'aria-labelledby', this.$name.id );

        this.$input.addEventListener( 'input', () => {
            this.setValue( this.$input.value );
        } );

        this.$input.addEventListener( 'keydown', e => {
            if ( e.code === 'Enter' ) {
                this.$input.blur();
            }
        } );

        this.$input.addEventListener( 'blur', () => {
            this._callOnFinishChange();
        } );

        this.$widget.appendChild( this.$input );

        this.$disable = this.$input;

        this.updateDisplay();

    }

    updateDisplay() {
        const value = this.getValue();
        if ( value !== this._lastDisplayedValue ) {
            this.$input.value = value;
            this._lastDisplayedValue = value;
        }
        return this;
    }

}

const stylesheet = `.lil-gui {
  font-family: var(--font-family);
  font-size: var(--font-size);
  line-height: 1;
  font-weight: normal;
  font-style: normal;
  text-align: left;
  color: var(--text-color);
  user-select: none;
  -webkit-user-select: none;
  touch-action: manipulation;
  --background-color: #1f1f1f;
  --text-color: #ebebeb;
  --title-background-color: #111111;
  --title-text-color: #ebebeb;
  --widget-color: #424242;
  --hover-color: #4f4f4f;
  --focus-color: #595959;
  --number-color: #2cc9ff;
  --string-color: #a2db3c;
  --font-size: 11px;
  --input-font-size: 11px;
  --font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
  --font-family-mono: Menlo, Monaco, Consolas, "Droid Sans Mono", monospace;
  --padding: 4px;
  --spacing: 4px;
  --widget-height: 20px;
  --title-height: calc(var(--widget-height) + var(--spacing) * 1.25);
  --name-width: 36%;
  --slider-knob-width: 2px;
  --slider-input-width: 27%;
  --color-input-width: 27%;
  --slider-input-min-width: 45px;
  --color-input-min-width: 45px;
  --folder-indent: 7px;
  --widget-padding: 0 0 0 3px;
  --widget-border-radius: 2px;
  --checkbox-size: calc(0.75 * var(--widget-height));
  --scrollbar-width: 5px;
}
.lil-gui, .lil-gui * {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}
.lil-gui.root {
  width: var(--width, 245px);
  display: flex;
  flex-direction: column;
  background: var(--background-color);
}
.lil-gui.root > .title {
  background: var(--title-background-color);
  color: var(--title-text-color);
}
.lil-gui.root > .children {
  overflow-x: hidden;
  overflow-y: auto;
}
.lil-gui.root > .children::-webkit-scrollbar {
  width: var(--scrollbar-width);
  height: var(--scrollbar-width);
  background: var(--background-color);
}
.lil-gui.root > .children::-webkit-scrollbar-thumb {
  border-radius: var(--scrollbar-width);
  background: var(--focus-color);
}
@media (pointer: coarse) {
  .lil-gui.allow-touch-styles, .lil-gui.allow-touch-styles .lil-gui {
    --widget-height: 28px;
    --padding: 6px;
    --spacing: 6px;
    --font-size: 13px;
    --input-font-size: 16px;
    --folder-indent: 10px;
    --scrollbar-width: 7px;
    --slider-input-min-width: 50px;
    --color-input-min-width: 65px;
  }
}
.lil-gui.force-touch-styles, .lil-gui.force-touch-styles .lil-gui {
  --widget-height: 28px;
  --padding: 6px;
  --spacing: 6px;
  --font-size: 13px;
  --input-font-size: 16px;
  --folder-indent: 10px;
  --scrollbar-width: 7px;
  --slider-input-min-width: 50px;
  --color-input-min-width: 65px;
}
.lil-gui.autoPlace {
  max-height: 100%;
  position: fixed;
  top: 0;
  right: 15px;
  z-index: 1001;
}

.lil-gui .controller {
  display: flex;
  align-items: center;
  padding: 0 var(--padding);
  margin: var(--spacing) 0;
}
.lil-gui .controller.disabled {
  opacity: 0.5;
}
.lil-gui .controller.disabled, .lil-gui .controller.disabled * {
  pointer-events: none !important;
}
.lil-gui .controller > .name {
  min-width: var(--name-width);
  flex-shrink: 0;
  white-space: pre;
  padding-right: var(--spacing);
  line-height: var(--widget-height);
}
.lil-gui .controller .widget {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
  min-height: var(--widget-height);
}
.lil-gui .controller.string input {
  color: var(--string-color);
}
.lil-gui .controller.boolean {
  cursor: pointer;
}
.lil-gui .controller.color .display {
  width: 100%;
  height: var(--widget-height);
  border-radius: var(--widget-border-radius);
  position: relative;
}
@media (hover: hover) {
  .lil-gui .controller.color .display:hover:before {
    content: " ";
    display: block;
    position: absolute;
    border-radius: var(--widget-border-radius);
    border: 1px solid #fff9;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
  }
}
.lil-gui .controller.color input[type=color] {
  opacity: 0;
  width: 100%;
  height: 100%;
  cursor: pointer;
}
.lil-gui .controller.color input[type=text] {
  margin-left: var(--spacing);
  font-family: var(--font-family-mono);
  min-width: var(--color-input-min-width);
  width: var(--color-input-width);
  flex-shrink: 0;
}
.lil-gui .controller.option select {
  opacity: 0;
  position: absolute;
  width: 100%;
  max-width: 100%;
}
.lil-gui .controller.option .display {
  position: relative;
  pointer-events: none;
  border-radius: var(--widget-border-radius);
  height: var(--widget-height);
  line-height: var(--widget-height);
  max-width: 100%;
  overflow: hidden;
  word-break: break-all;
  padding-left: 0.55em;
  padding-right: 1.75em;
  background: var(--widget-color);
}
@media (hover: hover) {
  .lil-gui .controller.option .display.focus {
    background: var(--focus-color);
  }
}
.lil-gui .controller.option .display.active {
  background: var(--focus-color);
}
.lil-gui .controller.option .display:after {
  font-family: "lil-gui";
  content: "↕";
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  padding-right: 0.375em;
}
.lil-gui .controller.option .widget,
.lil-gui .controller.option select {
  cursor: pointer;
}
@media (hover: hover) {
  .lil-gui .controller.option .widget:hover .display {
    background: var(--hover-color);
  }
}
.lil-gui .controller.number input {
  color: var(--number-color);
}
.lil-gui .controller.number.hasSlider input {
  margin-left: var(--spacing);
  width: var(--slider-input-width);
  min-width: var(--slider-input-min-width);
  flex-shrink: 0;
}
.lil-gui .controller.number .slider {
  width: 100%;
  height: var(--widget-height);
  background: var(--widget-color);
  border-radius: var(--widget-border-radius);
  padding-right: var(--slider-knob-width);
  overflow: hidden;
  cursor: ew-resize;
  touch-action: pan-y;
}
@media (hover: hover) {
  .lil-gui .controller.number .slider:hover {
    background: var(--hover-color);
  }
}
.lil-gui .controller.number .slider.active {
  background: var(--focus-color);
}
.lil-gui .controller.number .slider.active .fill {
  opacity: 0.95;
}
.lil-gui .controller.number .fill {
  height: 100%;
  border-right: var(--slider-knob-width) solid var(--number-color);
  box-sizing: content-box;
}

.lil-gui-dragging .lil-gui {
  --hover-color: var(--widget-color);
}
.lil-gui-dragging * {
  cursor: ew-resize !important;
}

.lil-gui-dragging.lil-gui-vertical * {
  cursor: ns-resize !important;
}

.lil-gui .title {
  height: var(--title-height);
  line-height: calc(var(--title-height) - 4px);
  font-weight: 600;
  padding: 0 var(--padding);
  -webkit-tap-highlight-color: transparent;
  cursor: pointer;
  outline: none;
  text-decoration-skip: objects;
}
.lil-gui .title:before {
  font-family: "lil-gui";
  content: "▾";
  padding-right: 2px;
  display: inline-block;
}
.lil-gui .title:active {
  background: var(--title-background-color);
  opacity: 0.75;
}
@media (hover: hover) {
  body:not(.lil-gui-dragging) .lil-gui .title:hover {
    background: var(--title-background-color);
    opacity: 0.85;
  }
  .lil-gui .title:focus {
    text-decoration: underline var(--focus-color);
  }
}
.lil-gui.root > .title:focus {
  text-decoration: none !important;
}
.lil-gui.closed > .title:before {
  content: "▸";
}
.lil-gui.closed > .children {
  transform: translateY(-7px);
  opacity: 0;
}
.lil-gui.closed:not(.transition) > .children {
  display: none;
}
.lil-gui.transition > .children {

  transition-property: height, opacity, transform;
  transition-timing-function: cubic-bezier(0.2, 0.6, 0.35, 1);
  overflow: hidden;
  pointer-events: none;
}
.lil-gui .children:empty:before {
  content: "Empty";
  padding: 0 var(--padding);
  margin: var(--spacing) 0;
  display: block;
  height: var(--widget-height);
  font-style: italic;
  line-height: var(--widget-height);
  opacity: 0.5;
}
.lil-gui.root > .children > .lil-gui > .title {
  border: 0 solid var(--widget-color);
  border-width: 1px 0;
  transition: border-color 300ms;

}
.lil-gui.root > .children > .lil-gui.closed > .title {
  border-bottom-color: transparent;
}
.lil-gui + .controller {
  border-top: 1px solid var(--widget-color);
  margin-top: 0;
  padding-top: var(--spacing);
}
.lil-gui .lil-gui .lil-gui > .title {
  border: none;
}

.lil-gui .lil-gui .lil-gui > .children {
  border: none;
  margin-left: var(--folder-indent);
  border-left: 2px solid var(--widget-color);
}

.lil-gui .lil-gui .controller {
  border: none;
}

.lil-gui label, .lil-gui input, .lil-gui button {
  -webkit-tap-highlight-color: transparent;
}
.lil-gui input {
  border: 0;
  outline: none;
  font-family: var(--font-family);
  font-size: var(--input-font-size);
  border-radius: var(--widget-border-radius);
  height: var(--widget-height);
  background: var(--widget-color);
  color: var(--text-color);
  width: 100%;
}
@media (hover: hover) {
  .lil-gui input:hover {
    background: var(--hover-color);
  }
  .lil-gui input:active {
    background: var(--focus-color);
  }
}
.lil-gui input:disabled {
  opacity: 1;
}
.lil-gui input[type=text],
.lil-gui input[type=number] {
  padding: var(--widget-padding);
  -moz-appearance: textfield;
}
.lil-gui input[type=text]:focus,
.lil-gui input[type=number]:focus {
  background: var(--focus-color);
}
.lil-gui input[type=checkbox] {
  appearance: none;
  width: var(--checkbox-size);
  height: var(--checkbox-size);
  border-radius: var(--widget-border-radius);
  text-align: center;
  cursor: pointer;
}
.lil-gui input[type=checkbox]:checked:before {
  font-family: "lil-gui";
  content: "✓";
  font-size: var(--checkbox-size);
  line-height: var(--checkbox-size);
}
@media (hover: hover) {
  .lil-gui input[type=checkbox]:focus {
    box-shadow: inset 0 0 0 1px var(--focus-color);
  }
}
.lil-gui button {
  outline: none;
  cursor: pointer;
  font-family: var(--font-family);
  font-size: var(--font-size);
  color: var(--text-color);
  width: 100%;
  height: var(--widget-height);
  text-transform: none;
  background: var(--widget-color);
  border-radius: var(--widget-border-radius);
  border: none;
}
@media (hover: hover) {
  .lil-gui button:hover {
    background: var(--hover-color);
  }
  .lil-gui button:focus {
    box-shadow: inset 0 0 0 1px var(--focus-color);
  }
}
.lil-gui button:active {
  background: var(--focus-color);
}

@font-face {
  font-family: "lil-gui";
  src: url("data:application/font-woff;charset=utf-8;base64,d09GRgABAAAAAAUsAAsAAAAACJwAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAABHU1VCAAABCAAAAH4AAADAImwmYE9TLzIAAAGIAAAAPwAAAGBKqH5SY21hcAAAAcgAAAD0AAACrukyyJBnbHlmAAACvAAAAF8AAACEIZpWH2hlYWQAAAMcAAAAJwAAADZfcj2zaGhlYQAAA0QAAAAYAAAAJAC5AHhobXR4AAADXAAAABAAAABMAZAAAGxvY2EAAANsAAAAFAAAACgCEgIybWF4cAAAA4AAAAAeAAAAIAEfABJuYW1lAAADoAAAASIAAAIK9SUU/XBvc3QAAATEAAAAZgAAAJCTcMc2eJxVjbEOgjAURU+hFRBK1dGRL+ALnAiToyMLEzFpnPz/eAshwSa97517c/MwwJmeB9kwPl+0cf5+uGPZXsqPu4nvZabcSZldZ6kfyWnomFY/eScKqZNWupKJO6kXN3K9uCVoL7iInPr1X5baXs3tjuMqCtzEuagm/AAlzQgPAAB4nGNgYRBlnMDAysDAYM/gBiT5oLQBAwuDJAMDEwMrMwNWEJDmmsJwgCFeXZghBcjlZMgFCzOiKOIFAB71Bb8AeJy1kjFuwkAQRZ+DwRAwBtNQRUGKQ8OdKCAWUhAgKLhIuAsVSpWz5Bbkj3dEgYiUIszqWdpZe+Z7/wB1oCYmIoboiwiLT2WjKl/jscrHfGg/pKdMkyklC5Zs2LEfHYpjcRoPzme9MWWmk3dWbK9ObkWkikOetJ554fWyoEsmdSlt+uR0pCJR34b6t/TVg1SY3sYvdf8vuiKrpyaDXDISiegp17p7579Gp3p++y7HPAiY9pmTibljrr85qSidtlg4+l25GLCaS8e6rRxNBmsnERunKbaOObRz7N72ju5vdAjYpBXHgJylOAVsMseDAPEP8LYoUHicY2BiAAEfhiAGJgZWBgZ7RnFRdnVJELCQlBSRlATJMoLV2DK4glSYs6ubq5vbKrJLSbGrgEmovDuDJVhe3VzcXFwNLCOILB/C4IuQ1xTn5FPilBTj5FPmBAB4WwoqAHicY2BkYGAA4sk1sR/j+W2+MnAzpDBgAyEMQUCSg4EJxAEAwUgFHgB4nGNgZGBgSGFggJMhDIwMqEAYAByHATJ4nGNgAIIUNEwmAABl3AGReJxjYAACIQYlBiMGJ3wQAEcQBEV4nGNgZGBgEGZgY2BiAAEQyQWEDAz/wXwGAAsPATIAAHicXdBNSsNAHAXwl35iA0UQXYnMShfS9GPZA7T7LgIu03SSpkwzYTIt1BN4Ak/gKTyAeCxfw39jZkjymzcvAwmAW/wgwHUEGDb36+jQQ3GXGot79L24jxCP4gHzF/EIr4jEIe7wxhOC3g2TMYy4Q7+Lu/SHuEd/ivt4wJd4wPxbPEKMX3GI5+DJFGaSn4qNzk8mcbKSR6xdXdhSzaOZJGtdapd4vVPbi6rP+cL7TGXOHtXKll4bY1Xl7EGnPtp7Xy2n00zyKLVHfkHBa4IcJ2oD3cgggWvt/V/FbDrUlEUJhTn/0azVWbNTNr0Ens8de1tceK9xZmfB1CPjOmPH4kitmvOubcNpmVTN3oFJyjzCvnmrwhJTzqzVj9jiSX911FjeAAB4nG3HMRKCMBBA0f0giiKi4DU8k0V2GWbIZDOh4PoWWvq6J5V8If9NVNQcaDhyouXMhY4rPTcG7jwYmXhKq8Wz+p762aNaeYXom2n3m2dLTVgsrCgFJ7OTmIkYbwIbC6vIB7WmFfAAAA==") format("woff");
}`;

function _injectStyles( cssContent ) {
    const injected = document.createElement( 'style' );
    injected.innerHTML = cssContent;
    const before = document.querySelector( 'head link[rel=stylesheet], head style' );
    if ( before ) {
        document.head.insertBefore( injected, before );
    } else {
        document.head.appendChild( injected );
    }
}

let stylesInjected = false;

class GUI {

    /**
     * Creates a panel that holds controllers.
     * @example
     * new GUI();
     * new GUI( { container: document.getElementById( 'custom' ) } );
     *
     * @param {object} [options]
     * @param {boolean} [options.autoPlace=true]
     * Adds the GUI to `document.body` and fixes it to the top right of the page.
     *
     * @param {HTMLElement} [options.container]
     * Adds the GUI to this DOM element. Overrides `autoPlace`.
     *
     * @param {number} [options.width=245]
     * Width of the GUI in pixels, usually set when name labels become too long. Note that you can make
     * name labels wider in CSS with `.lil‑gui { ‑‑name‑width: 55% }`.
     *
     * @param {string} [options.title=Controls]
     * Name to display in the title bar.
     *
     * @param {boolean} [options.closeFolders=false]
     * Pass `true` to close all folders in this GUI by default.
     *
     * @param {boolean} [options.injectStyles=true]
     * Injects the default stylesheet into the page if this is the first GUI.
     * Pass `false` to use your own stylesheet.
     *
     * @param {number} [options.touchStyles=true]
     * Makes controllers larger on touch devices. Pass `false` to disable touch styles.
     *
     * @param {GUI} [options.parent]
     * Adds this GUI as a child in another GUI. Usually this is done for you by `addFolder()`.
     *
     */
    constructor( {
                     parent,
                     autoPlace = parent === undefined,
                     container,
                     width,
                     title = 'Controls',
                     closeFolders = false,
                     injectStyles = true,
                     touchStyles = true
                 } = {} ) {

        /**
         * The GUI containing this folder, or `undefined` if this is the root GUI.
         * @type {GUI}
         */
        this.parent = parent;

        /**
         * The top level GUI containing this folder, or `this` if this is the root GUI.
         * @type {GUI}
         */
        this.root = parent ? parent.root : this;

        /**
         * The list of controllers and folders contained by this GUI.
         * @type {Array<GUI|Controller>}
         */
        this.children = [];

        /**
         * The list of controllers contained by this GUI.
         * @type {Array<Controller>}
         */
        this.controllers = [];

        /**
         * The list of folders contained by this GUI.
         * @type {Array<GUI>}
         */
        this.folders = [];

        /**
         * Used to determine if the GUI is closed. Use `gui.open()` or `gui.close()` to change this.
         * @type {boolean}
         */
        this._closed = false;

        /**
         * Used to determine if the GUI is hidden. Use `gui.show()` or `gui.hide()` to change this.
         * @type {boolean}
         */
        this._hidden = false;

        /**
         * The outermost container element.
         * @type {HTMLElement}
         */
        this.domElement = document.createElement( 'div' );
        this.domElement.classList.add( 'lil-gui' );

        /**
         * The DOM element that contains the title.
         * @type {HTMLElement}
         */
        this.$title = document.createElement( 'div' );
        this.$title.classList.add( 'title' );
        this.$title.setAttribute( 'role', 'button' );
        this.$title.setAttribute( 'aria-expanded', true );
        this.$title.setAttribute( 'tabindex', 0 );

        // MICK: changed to mousedown
        this.$title.addEventListener( 'mousedown', () => {
            this.openAnimated( this._closed )
        } );
        // Right-click on title acts like a regular click (no browser context menu)
        this.$title.addEventListener( 'contextmenu', e => e.preventDefault() );
        this.$title.addEventListener( 'keydown', e => {
            if ( e.code === 'Enter' || e.code === 'Space' ) {
                e.preventDefault();
                this.$title.click();
            }
        } );

        // enables :active pseudo class on mobile
        this.$title.addEventListener( 'touchstart', () => {}, { passive: true } );

        /**
         * The DOM element that contains children.
         * @type {HTMLElement}
         */
        this.$children = document.createElement( 'div' );
        this.$children.classList.add( 'children' );

        this.domElement.appendChild( this.$title );
        this.domElement.appendChild( this.$children );

        // MICK: stop wheel events from propagating to the underlying application
        this.domElement.addEventListener( 'wheel', e => e.stopPropagation(), { passive: true } );

        this.title( title );

        if ( this.parent ) {

            this.parent.children.push( this );
            this.parent.folders.push( this );

            this.parent.$children.appendChild( this.domElement );

            // Stop the constructor early, everything onward only applies to root GUI's
            return;

        }

        this.domElement.classList.add( 'root' );

        if ( touchStyles ) {
            this.domElement.classList.add( 'allow-touch-styles' );
        }

        // Inject stylesheet if we haven't done that yet
        if ( !stylesInjected && injectStyles ) {
            _injectStyles( stylesheet );
            stylesInjected = true;
        }

        if ( container ) {

            container.appendChild( this.domElement );

        } else if ( autoPlace ) {

            this.domElement.classList.add( 'autoPlace' );
            document.body.appendChild( this.domElement );

        }

        if ( width ) {
            this.domElement.style.setProperty( '--width', width + 'px' );
        }

        // Mick: Only stop key event propagation for text inputs in the GUI.
        // Mick: Non-text controls let events through to the document-level handler.
        this.domElement.addEventListener( 'keydown', e => {
            const el = document.activeElement;
            if (el) {
                const tag = el.tagName.toLowerCase();
                const type = (el.type || '').toLowerCase();
                if (tag === 'textarea' || (tag === 'input' && (type === 'text' || type === 'number'))) {
                    e.stopPropagation();
                    return;
                }
            }
        } );
        this.domElement.addEventListener( 'keyup', e => {
            const el = document.activeElement;
            if (el) {
                const tag = el.tagName.toLowerCase();
                const type = (el.type || '').toLowerCase();
                if (tag === 'textarea' || (tag === 'input' && (type === 'text' || type === 'number'))) {
                    e.stopPropagation();
                }
            }
        } );

        this._closeFolders = closeFolders;

    }

    /**
     * Adds a controller to the GUI, inferring controller type using the `typeof` operator.
     * @example
     * gui.add( object, 'property' );
     * gui.add( object, 'number', 0, 100, 1 );
     * gui.add( object, 'options', [ 1, 2, 3 ] );
     *
     * @param {object} object The object the controller will modify.
     * @param {string} property Name of the property to control.
     * @param {number|object|Array} [$1] Minimum value for number controllers, or the set of
     * selectable values for a dropdown.
     * @param {number} [max] Maximum value for number controllers.
     * @param {number} [step] Step value for number controllers.
     * @returns {Controller}
     */
    add( object, property, $1, max, step, snap ) {

        if ( Object( $1 ) === $1 ) {

            return new OptionController( this, object, property, $1 );

        }

        assert( object, "Object must exist in order to add property " + property + "!")

        const initialValue = object[ property ];

        switch ( typeof initialValue ) {

            case 'number':

                return new NumberController( this, object, property, $1, max, step, snap );

            case 'boolean':

                return new BooleanController( this, object, property );

            case 'string':

                return new StringController( this, object, property );

            case 'function':

                return new FunctionController( this, object, property );

        }

        showError( `gui.add failed
	property:`, property, `
	object:`, object, `
	value:`, initialValue );

    }

    /**
     * Adds a color controller to the GUI.
     * @example
     * params = {
     * 	cssColor: '#ff00ff',
     * 	rgbColor: { r: 0, g: 0.2, b: 0.4 },
     * 	customRange: [ 0, 127, 255 ],
     * };
     *
     * gui.addColor( params, 'cssColor' );
     * gui.addColor( params, 'rgbColor' );
     * gui.addColor( params, 'customRange', 255 );
     *
     * @param {object} object The object the controller will modify.
     * @param {string} property Name of the property to control.
     * @param {number} rgbScale Maximum value for a color channel when using an RGB color. You may
     * need to set this to 255 if your colors are too bright.
     * @returns {Controller}
     */
    addColor( object, property, rgbScale = 1 ) {
        return new ColorController( this, object, property, rgbScale );
    }

    /**
     * Adds a folder to the GUI, which is just another GUI. This method returns
     * the nested GUI so you can add controllers to it.
     * @example
     * const folder = gui.addFolder( 'Position' );
     * folder.add( position, 'x' );
     * folder.add( position, 'y' );
     * folder.add( position, 'z' );
     *
     * @param {string} title Name to display in the folder's title bar.
     * @returns {GUI}
     */
    addFolder( title ) {
        const folder = new GUI( { parent: this, title } );
        if ( this.root._closeFolders ) folder.close();
        return folder;
    }

    /**
     * Recalls values that were saved with `gui.save()`.
     * @param {object} obj
     * @param {boolean} recursive Pass false to exclude folders descending from this GUI.
     * @returns {this}
     */
    load( obj, recursive = true ) {

        if ( obj.controllers ) {

            this.controllers.forEach( c => {

                if ( c instanceof FunctionController ) return;

                if ( c._name in obj.controllers ) {
                    c.load( obj.controllers[ c._name ] );
                }

            } );

        }

        if ( recursive && obj.folders ) {

            this.folders.forEach( f => {

                if ( f._title in obj.folders ) {
                    f.load( obj.folders[ f._title ] );
                }

            } );

        }

        return this;

    }

    /**
     * Returns an object mapping controller names to values. The object can be passed to `gui.load()` to
     * recall these values.
     * @example
     * {
     * 	controllers: {
     * 		prop1: 1,
     * 		prop2: 'value',
     * 		...
     * 	},
     * 	folders: {
     * 		folderName1: { controllers, folders },
     * 		folderName2: { controllers, folders }
     * 		...
     * 	}
     * }
     *
     * @param {boolean} recursive Pass false to exclude folders descending from this GUI.
     * @returns {object}
     */
    save( recursive = true ) {

        const obj = {
            controllers: {},
            folders: {}
        };

        this.controllers.forEach( c => {

            if ( c instanceof FunctionController ) return;

            if ( c._name in obj.controllers ) {
                throw new Error( `Cannot save GUI with duplicate property "${c._name}"` );
            }

            obj.controllers[ c._name ] = c.save();

        } );

        if ( recursive ) {

            this.folders.forEach( f => {

                if ( f._title in obj.folders ) {
                    throw new Error( `Cannot save GUI with duplicate folder "${f._title}"` );
                }

                obj.folders[ f._title ] = f.save();

            } );

        }

        return obj;

    }

    /**
     * Opens a GUI or folder. GUI and folders are open by default.
     * @param {boolean} open Pass false to close.
     * @returns {this}
     * @example
     * gui.open(); // open
     * gui.open( false ); // close
     * gui.open( gui._closed ); // toggle
     */
    open( open = true ) {
        if (this.lockOpenClose) return; // MICK

        this._setClosed( !open );

        this.$title.setAttribute( 'aria-expanded', !this._closed );
        this.domElement.classList.toggle( 'closed', this._closed );

        return this;

    }

    /**
     * Closes the GUI.
     * @returns {this}
     */
    close() {
        return this.open( false );
    }

    _setClosed( closed ) {
        if ( this._closed === closed ) return;
        this._closed = closed;
        this._callOnOpenClose( this );
    }

    /**
     * Shows the GUI after it's been hidden.
     * @param {boolean} show
     * @returns {this}
     * @example
     * gui.show();
     * gui.show( false ); // hide
     * gui.show( gui._hidden ); // toggle
     */
    show( show = true ) {

        this._hidden = !show;

        this.domElement.style.display = this._hidden ? 'none' : '';

        return this;

    }

    /**
     * Hides the GUI.
     * @returns {this}
     */
    hide() {
        return this.show( false );
    }

    openAnimated( open = true ) {

        // set state immediately
        this._closed = !open;

        this.$title.setAttribute( 'aria-expanded', !this._closed );

        // wait for next frame to measure $children
        requestAnimationFrame( () => {

            // explicitly set initial height for transition
            const initialHeight = this.$children.clientHeight;
            this.$children.style.height = initialHeight + 'px';

            this.domElement.classList.add( 'transition' );

            const onTransitionEnd = e => {
                if ( e.target !== this.$children ) return;
                this.$children.style.height = '';
                this.domElement.classList.remove( 'transition' );
                this.$children.removeEventListener( 'transitionend', onTransitionEnd );
            };

            this.$children.addEventListener( 'transitionend', onTransitionEnd );

            // todo: this is wrong if children's scrollHeight makes for a gui taller than maxHeight
            const targetHeight = !open ? 0 : this.$children.scrollHeight;

            this.domElement.classList.toggle( 'closed', !open );

            requestAnimationFrame( () => {
                this.$children.style.height = targetHeight + 'px';
            } );

        } );

        return this;

    }

    /**
     * Change the title of this GUI.
     * @param {string} title
     * @returns {this}
     */
    title( title ) {
        /**
         * Current title of the GUI. Use `gui.title( 'Title' )` to modify this value.
         * @type {string}
         */
        this._title = title;
        // SITREC PATCH (security): textContent, not innerHTML — see the note in name().
        // Folder titles carry untrusted data too: a sitch's customGraphs[].title reaches
        // guiMenus.showhidegraphs.addFolder(), and loaded track filenames reach
        // guiMenus.contents.addFolder(). Re-apply this when upgrading lil-gui.
        this.$title.textContent = title;
        return this;
    }

    /**
     * Resets all controllers to their initial values.
     * @param {boolean} recursive Pass false to exclude folders descending from this GUI.
     * @returns {this}
     */
    reset( recursive = true ) {
        const controllers = recursive ? this.controllersRecursive() : this.controllers;
        controllers.forEach( c => c.reset() );
        return this;
    }

    /**
     * Pass a function to be called whenever a controller in this GUI changes.
     * @param {function({object:object, property:string, value:any, controller:Controller})} callback
     * @returns {this}
     * @example
     * gui.onChange( event => {
     * 	event.object     // object that was modified
     * 	event.property   // string, name of property
     * 	event.value      // new value of controller
     * 	event.controller // controller that was modified
     * } );
     */
    onChange( callback ) {
        /**
         * Used to access the function bound to `onChange` events. Don't modify this value
         * directly. Use the `gui.onChange( callback )` method instead.
         * @type {Function}
         */
        this._onChange = callback;
        return this;
    }

    _callOnChange( controller ) {

        if ( this.parent ) {
            this.parent._callOnChange( controller );
        }

        if ( this._onChange !== undefined ) {
            this._onChange.call( this, {
                object: controller.object,
                property: controller.property,
                value: controller.getValue(),
                controller
            } );
        }
    }

    /**
     * Pass a function to be called whenever a controller in this GUI has finished changing.
     * @param {function({object:object, property:string, value:any, controller:Controller})} callback
     * @returns {this}
     * @example
     * gui.onFinishChange( event => {
     * 	event.object     // object that was modified
     * 	event.property   // string, name of property
     * 	event.value      // new value of controller
     * 	event.controller // controller that was modified
     * } );
     */
    onFinishChange( callback ) {
        /**
         * Used to access the function bound to `onFinishChange` events. Don't modify this value
         * directly. Use the `gui.onFinishChange( callback )` method instead.
         * @type {Function}
         */
        this._onFinishChange = callback;
        return this;
    }

    _callOnFinishChange( controller ) {

        if ( this.parent ) {
            this.parent._callOnFinishChange( controller );
        }

        if ( this._onFinishChange !== undefined ) {
            this._onFinishChange.call( this, {
                object: controller.object,
                property: controller.property,
                value: controller.getValue(),
                controller
            } );
        }
    }

    /**
     * Pass a function to be called when this GUI or its descendants are opened or closed.
     * @param {function(GUI)} callback
     * @returns {this}
     * @example
     * gui.onOpenClose( changedGUI => {
     * 	console.log( changedGUI._closed );
     * } );
     */
    onOpenClose( callback ) {
        this._onOpenClose = callback;
        return this;
    }

    _callOnOpenClose( changedGUI ) {
        if ( this.parent ) {
            this.parent._callOnOpenClose( changedGUI );
        }

        if ( this._onOpenClose !== undefined ) {
            this._onOpenClose.call( this, changedGUI );
        }
    }

    /**
     * Destroys all DOM elements and event listeners associated with this GUI.
     */
    // MICK: modified to allow some to be permanent.
    destroy(all = true) {

        if (all || !this.permanent) {
            if (this.parent) {
                this.parent.children.splice(this.parent.children.indexOf(this), 1);

                // not sure about this....
                this.parent.folders.splice(this.parent.folders.indexOf(this), 1);
            }

            if (this.domElement.parentElement) {
                this.domElement.parentElement.removeChild(this.domElement);
            }
        }

        Array.from( this.children ).forEach( c => c.destroy(all) );

    }

    // MICK: added to allow some to be permanent.
    perm() {
        this.permanent = true;
        return this;
    }

    /**
     * Returns an array of controllers contained by this GUI and its descendents.
     * @returns {Controller[]}
     */
    controllersRecursive() {
        let controllers = Array.from( this.controllers );
        this.folders.forEach( f => {
            controllers = controllers.concat( f.controllersRecursive() );
        } );
        return controllers;
    }

    /**
     * Returns an array of folders contained by this GUI and its descendents.
     * @returns {GUI[]}
     */
    foldersRecursive() {
        let folders = Array.from( this.folders );
        this.folders.forEach( f => {
            folders = folders.concat( f.foldersRecursive() );
        } );
        return folders;
    }


    // MICK: Added this method
    // Iterates over all controllers in the GUI and calls the updateDisplay method
    // if the listener is not set to false.
    // to is to avoid having the requestAnimationFrame loop in the controllers
    // which is making code difficult to debug.
    // this makes it part of the main loop
    updateListeners() {
        const controllerList = this.controllersRecursive()
        for (const controller of controllerList) {
            if (controller._listening) {
                const curValue = controller.save();



                if (curValue !== controller._listenPrevValue) {

                // MICK: expand the slider range AND the elastic range if we are outside them
                    if (controller._elastic) {

                        let value = curValue;

                        // if it gets set above the elastic max, then expand that to match
                        if (value > controller._elasticMax) {
                            controller._elasticMax = value;
                        }

                        // if it's above the current max, then expand that in steps
                        while (value > controller._max && controller._max < controller._elasticMax) {
                            controller._max = Math.min(controller._max * 2, controller._elasticMax);

                           // console.log("Expanding max to: " + controller._max + "for: " + controller._name + " as value: " + value);

                        }
                    }

                    controller._listenPrevValue = curValue;
                    controller.updateDisplay();
                 //   controller._callOnChange();
                }


            }
        }
    }

}

export default GUI;
export { BooleanController, ColorController, Controller, FunctionController, GUI, NumberController, OptionController, StringController };
