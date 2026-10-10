import * as radiometry from "../tools/thermal/radiometry.js";

// Independent fixtures: SciPy 1.16 QUADPACK integration in x=h*frequency/(k*T),
// and B_nu transformed with the wavelength Jacobian. SI h,c,k from the published SI definition.
// These literals are independent of the wavelength-space JavaScript quadrature.
const bands = [{"minUm": 3, "maxUm": 5}, {"minUm": 3.7, "maxUm": 4.8}, {"minUm": 3, "maxUm": 5, "samples": [[3, 0], [3.4, 0.3], [3.8, 0.85], [4.2, 0.7], [4.6, 0.9], [5, 0]]}, {"minUm": 3, "maxUm": 5, "kind": "step", "edgeUm": 4.13, "breakpointsUm": [4.13]}];
const bandFixtures = [
  {
    "temperatureK": 0,
    "bandIndex": 0,
    "energy": 0.0,
    "photon": 0.0
  },
  {
    "temperatureK": 180,
    "bandIndex": 0,
    "energy": 0.0016487799516964633,
    "photon": 3.877547219858243e+16
  },
  {
    "temperatureK": 220,
    "bandIndex": 0,
    "energy": 0.03850205084455345,
    "photon": 8.909440265680256e+17
  },
  {
    "temperatureK": 240,
    "bandIndex": 0,
    "energy": 0.1276238839752437,
    "photon": 2.9294648062343496e+18
  },
  {
    "temperatureK": 250,
    "bandIndex": 0,
    "energy": 0.2170349665103336,
    "photon": 4.961822810383707e+18
  },
  {
    "temperatureK": 255,
    "bandIndex": 0,
    "energy": 0.27888203922809945,
    "photon": 6.363022949206743e+18
  },
  {
    "temperatureK": 260,
    "bandIndex": 0,
    "energy": 0.3551087987632543,
    "photon": 8.08609354740832e+18
  },
  {
    "temperatureK": 270,
    "bandIndex": 0,
    "energy": 0.561374449314611,
    "photon": 1.273236283697293e+19
  },
  {
    "temperatureK": 280,
    "bandIndex": 0,
    "energy": 0.8605360776830535,
    "photon": 1.94410757467923e+19
  },
  {
    "temperatureK": 290.25,
    "bandIndex": 0,
    "energy": 1.2955531051870162,
    "photon": 2.9152618151226024e+19
  },
  {
    "temperatureK": 300,
    "bandIndex": 0,
    "energy": 1.8659562081616918,
    "photon": 4.183109126817968e+19
  },
  {
    "temperatureK": 500,
    "bandIndex": 0,
    "energy": 167.52777839600705,
    "photon": 3.526247950268731e+21
  },
  {
    "temperatureK": 800,
    "bandIndex": 0,
    "energy": 2518.1158928823575,
    "photon": 5.035672029889849e+22
  },
  {
    "temperatureK": 1500,
    "bandIndex": 0,
    "energy": 24676.99632676974,
    "photon": 4.7322210319688985e+23
  },
  {
    "temperatureK": 2000,
    "bandIndex": 0,
    "energy": 50933.149935764355,
    "photon": 9.661964622409278e+23
  },
  {
    "temperatureK": 3000,
    "bandIndex": 0,
    "energy": 115417.22384736748,
    "photon": 2.1680721915108214e+24
  },
  {
    "temperatureK": 5772,
    "bandIndex": 0,
    "energy": 321115.0013106285,
    "photon": 5.982577001998283e+24
  },
  {
    "temperatureK": 5778,
    "bandIndex": 0,
    "energy": 321576.7425548471,
    "photon": 5.991128416214216e+24
  },
  {
    "temperatureK": 0,
    "bandIndex": 1,
    "energy": 0.0,
    "photon": 0.0
  },
  {
    "temperatureK": 180,
    "bandIndex": 1,
    "energy": 0.0009358601327275518,
    "photon": 2.12586606189142e+16
  },
  {
    "temperatureK": 220,
    "bandIndex": 1,
    "energy": 0.024105864455747892,
    "photon": 5.4161373395447846e+17
  },
  {
    "temperatureK": 240,
    "bandIndex": 1,
    "energy": 0.08236719422021696,
    "photon": 1.8418335272283814e+18
  },
  {
    "temperatureK": 250,
    "bandIndex": 1,
    "energy": 0.14171912524979044,
    "photon": 3.1619971668240963e+18
  },
  {
    "temperatureK": 255,
    "bandIndex": 1,
    "energy": 0.18303211811423295,
    "photon": 4.079397608338623e+18
  },
  {
    "temperatureK": 260,
    "bandIndex": 1,
    "energy": 0.2341382228209075,
    "photon": 5.213002569462669e+18
  },
  {
    "temperatureK": 270,
    "bandIndex": 1,
    "energy": 0.3730822976123132,
    "photon": 8.289847203260657e+18
  },
  {
    "temperatureK": 280,
    "bandIndex": 1,
    "energy": 0.5755379092054261,
    "photon": 1.27639074408148e+19
  },
  {
    "temperatureK": 290.25,
    "bandIndex": 1,
    "energy": 0.8708523111957197,
    "photon": 1.927712205146066e+19
  },
  {
    "temperatureK": 300,
    "bandIndex": 1,
    "energy": 1.2587343139477696,
    "photon": 2.781607289195759e+19
  },
  {
    "temperatureK": 500,
    "bandIndex": 1,
    "energy": 106.91081436838967,
    "photon": 2.3101970850139218e+21
  },
  {
    "temperatureK": 800,
    "bandIndex": 1,
    "energy": 1381.660132555125,
    "photon": 2.9449316875310606e+22
  },
  {
    "temperatureK": 1500,
    "bandIndex": 1,
    "energy": 11255.646191019607,
    "photon": 2.3750670264581497e+23
  },
  {
    "temperatureK": 2000,
    "bandIndex": 1,
    "energy": 21924.604709448475,
    "photon": 4.61459550041786e+23
  },
  {
    "temperatureK": 3000,
    "bandIndex": 1,
    "energy": 46953.3720826428,
    "photon": 9.859748260581047e+23
  },
  {
    "temperatureK": 5772,
    "bandIndex": 1,
    "energy": 124189.02795651484,
    "photon": 2.602736188235858e+24
  },
  {
    "temperatureK": 5778,
    "bandIndex": 1,
    "energy": 124360.88516722454,
    "photon": 2.6063325957735464e+24
  },
  {
    "temperatureK": 0,
    "bandIndex": 2,
    "energy": 0.0,
    "photon": 0.0
  },
  {
    "temperatureK": 180,
    "bandIndex": 2,
    "energy": 0.000841631559076843,
    "photon": 1.9289823953875636e+16
  },
  {
    "temperatureK": 220,
    "bandIndex": 2,
    "energy": 0.021238062893970285,
    "photon": 4.798502520003531e+17
  },
  {
    "temperatureK": 240,
    "bandIndex": 2,
    "energy": 0.07228513313708691,
    "photon": 1.6224626088650598e+18
  },
  {
    "temperatureK": 250,
    "bandIndex": 2,
    "energy": 0.12426820671508775,
    "photon": 2.7804488074404e+18
  },
  {
    "temperatureK": 255,
    "bandIndex": 2,
    "energy": 0.1604647999332097,
    "photon": 3.584797467867054e+18
  },
  {
    "temperatureK": 260,
    "bandIndex": 2,
    "energy": 0.2052616344717508,
    "photon": 4.5786011728630057e+18
  },
  {
    "temperatureK": 270,
    "bandIndex": 2,
    "energy": 0.3271715280441711,
    "photon": 7.276312483972256e+18
  },
  {
    "temperatureK": 280,
    "bandIndex": 2,
    "energy": 0.5051038733243537,
    "photon": 1.1201275270619822e+19
  },
  {
    "temperatureK": 290.25,
    "bandIndex": 2,
    "energy": 0.7652006762994992,
    "photon": 1.6920872967190122e+19
  },
  {
    "temperatureK": 300,
    "bandIndex": 2,
    "energy": 1.107666946522051,
    "photon": 2.442954721882036e+19
  },
  {
    "temperatureK": 500,
    "bandIndex": 2,
    "energy": 99.67975270584277,
    "photon": 2.1147049906898626e+21
  },
  {
    "temperatureK": 800,
    "bandIndex": 2,
    "energy": 1392.523952070832,
    "photon": 2.87296810680136e+22
  },
  {
    "temperatureK": 1500,
    "bandIndex": 2,
    "energy": 12351.343784660388,
    "photon": 2.4909922102553894e+23
  },
  {
    "temperatureK": 2000,
    "bandIndex": 2,
    "energy": 24693.492676826485,
    "photon": 4.950072350465527e+23
  },
  {
    "temperatureK": 3000,
    "bandIndex": 2,
    "energy": 54240.738679602444,
    "photon": 1.0812453860871073e+24
  },
  {
    "temperatureK": 5772,
    "bandIndex": 2,
    "energy": 146764.2891615904,
    "photon": 2.9115982687329834e+24
  },
  {
    "temperatureK": 5778,
    "bandIndex": 2,
    "energy": 146970.96414880783,
    "photon": 2.9156836999291696e+24
  },
  {
    "temperatureK": 0,
    "bandIndex": 3,
    "energy": 0.0,
    "photon": 0.0
  },
  {
    "temperatureK": 180,
    "bandIndex": 3,
    "energy": 0.0011006263460031555,
    "photon": 2.608962617019584e+16
  },
  {
    "temperatureK": 220,
    "bandIndex": 3,
    "energy": 0.02467347389975143,
    "photon": 5.793693917622501e+17
  },
  {
    "temperatureK": 240,
    "bandIndex": 3,
    "energy": 0.07990628185579586,
    "photon": 1.8683049986223636e+18
  },
  {
    "temperatureK": 250,
    "bandIndex": 3,
    "energy": 0.13425329755585194,
    "photon": 3.132572038036512e+18
  },
  {
    "temperatureK": 255,
    "bandIndex": 3,
    "energy": 0.1714546441597484,
    "photon": 3.996580940536828e+18
  },
  {
    "temperatureK": 260,
    "bandIndex": 3,
    "energy": 0.2169707670848754,
    "photon": 5.052534204129519e+18
  },
  {
    "temperatureK": 270,
    "bandIndex": 3,
    "energy": 0.33873417996674243,
    "photon": 7.872629245291382e+18
  },
  {
    "temperatureK": 280,
    "bandIndex": 3,
    "energy": 0.5127267274409198,
    "photon": 1.1893745930753819e+19
  },
  {
    "temperatureK": 290.25,
    "bandIndex": 3,
    "energy": 0.7619175574357115,
    "photon": 1.7640477767012106e+19
  },
  {
    "temperatureK": 300,
    "bandIndex": 3,
    "energy": 1.0837993265558474,
    "photon": 2.50482596670173e+19
  },
  {
    "temperatureK": 500,
    "bandIndex": 3,
    "energy": 77.369895968862,
    "photon": 1.7342889506028913e+21
  },
  {
    "temperatureK": 800,
    "bandIndex": 3,
    "energy": 946.5179255689162,
    "photon": 2.0586748161798034e+22
  },
  {
    "temperatureK": 1500,
    "bandIndex": 3,
    "energy": 7754.641000935653,
    "photon": 1.6339441977399094e+23
  },
  {
    "temperatureK": 2000,
    "bandIndex": 3,
    "energy": 15261.119231509107,
    "photon": 3.184765011411789e+23
  },
  {
    "temperatureK": 3000,
    "bandIndex": 3,
    "energy": 33109.023729460016,
    "photon": 6.845160759693214e+23
  },
  {
    "temperatureK": 5772,
    "bandIndex": 3,
    "energy": 88782.71800111698,
    "photon": 1.8203293170297976e+24
  },
  {
    "temperatureK": 5778,
    "bandIndex": 3,
    "energy": 88906.96967858881,
    "photon": 1.82286068695636e+24
  }
];
const spectralFixtures = [
  {
    "wavelengthUm": 0.2,
    "temperatureK": 0,
    "energy": 0.0,
    "photon": 0.0
  },
  {
    "wavelengthUm": 3,
    "temperatureK": 0,
    "energy": 0.0,
    "photon": 0.0
  },
  {
    "wavelengthUm": 3.7,
    "temperatureK": 0,
    "energy": 0.0,
    "photon": 0.0
  },
  {
    "wavelengthUm": 4,
    "temperatureK": 0,
    "energy": 0.0,
    "photon": 0.0
  },
  {
    "wavelengthUm": 4.8,
    "temperatureK": 0,
    "energy": 0.0,
    "photon": 0.0
  },
  {
    "wavelengthUm": 5,
    "temperatureK": 0,
    "energy": 0.0,
    "photon": 0.0
  },
  {
    "wavelengthUm": 10,
    "temperatureK": 0,
    "energy": 0.0,
    "photon": 0.0
  },
  {
    "wavelengthUm": 1000,
    "temperatureK": 0,
    "energy": 0.0,
    "photon": 0.0
  },
  {
    "wavelengthUm": 0.2,
    "temperatureK": 180,
    "energy": 1.001241761073414e-162,
    "photon": 1.0080735475070624e-144
  },
  {
    "wavelengthUm": 3,
    "temperatureK": 180,
    "energy": 1.3151398097321795e-06,
    "photon": 19861701314423.195
  },
  {
    "wavelengthUm": 3.7,
    "temperatureK": 180,
    "energy": 7.124325555298395e-05,
    "photon": 1326993356488336.0
  },
  {
    "wavelengthUm": 4,
    "temperatureK": 180,
    "energy": 0.00024384595196832708,
    "photon": 4910195786927916.0
  },
  {
    "wavelengthUm": 4.8,
    "temperatureK": 180,
    "energy": 0.002739226842554808,
    "photon": 6.619001870574175e+16
  },
  {
    "wavelengthUm": 5,
    "temperatureK": 180,
    "energy": 0.0043477835888887355,
    "photon": 1.0943624698457541e+17
  },
  {
    "wavelengthUm": 10,
    "temperatureK": 180,
    "energy": 0.40241055982610024,
    "photon": 2.0257816661747077e+19
  },
  {
    "wavelengthUm": 1000,
    "temperatureK": 180,
    "energy": 1.4313104875628873e-06,
    "photon": 7205383838737964.0
  },
  {
    "wavelengthUm": 0.2,
    "temperatureK": 220,
    "energy": 3.620463193817351e-131,
    "photon": 3.645166749234904e-113
  },
  {
    "wavelengthUm": 3,
    "temperatureK": 220,
    "energy": 0.00016705273991374656,
    "photon": 2522888896959584.5
  },
  {
    "wavelengthUm": 3.7,
    "temperatureK": 220,
    "energy": 0.0036190432701277515,
    "photon": 6.740913703377502e+16
  },
  {
    "wavelengthUm": 4,
    "temperatureK": 220,
    "energy": 0.009226284514112965,
    "photon": 1.8578476691743526e+17
  },
  {
    "wavelengthUm": 4.8,
    "temperatureK": 220,
    "energy": 0.05656588003441869,
    "photon": 1.3668443224267223e+18
  },
  {
    "wavelengthUm": 5,
    "temperatureK": 220,
    "energy": 0.07954223376450277,
    "photon": 2.0021243840661924e+18
  },
  {
    "wavelengthUm": 10,
    "temperatureK": 220,
    "energy": 1.7231179936609158,
    "photon": 8.674376839719369e+19
  },
  {
    "wavelengthUm": 1000,
    "temperatureK": 220,
    "energy": 1.7622928054212736e-06,
    "photon": 8871587408632554.0
  },
  {
    "wavelengthUm": 0.2,
    "temperatureK": 240,
    "energy": 2.4722852609323364e-119,
    "photon": 2.4891544383502247e-101
  },
  {
    "wavelengthUm": 3,
    "temperatureK": 240,
    "energy": 0.0010275648346319624,
    "photon": 1.551864347473514e+16
  },
  {
    "wavelengthUm": 3.7,
    "temperatureK": 240,
    "energy": 0.015786562019000337,
    "photon": 2.940441555962433e+17
  },
  {
    "wavelengthUm": 4,
    "temperatureK": 240,
    "energy": 0.03603658805339655,
    "photon": 7.25649539829261e+17
  },
  {
    "wavelengthUm": 4.8,
    "temperatureK": 240,
    "energy": 0.17605684982349107,
    "photon": 4.2541953817239127e+18
  },
  {
    "wavelengthUm": 5,
    "temperatureK": 240,
    "energy": 0.23657723414798945,
    "photon": 5.954786869639122e+18
  },
  {
    "wavelengthUm": 10,
    "temperatureK": 240,
    "energy": 2.9747961603310813,
    "photon": 1.4975470635785132e+20
  },
  {
    "wavelengthUm": 1000,
    "temperatureK": 240,
    "energy": 1.9278019866558676e-06,
    "photon": 9704779919966052.0
  },
  {
    "wavelengthUm": 0.2,
    "temperatureK": 250,
    "energy": 3.982958071649969e-114,
    "photon": 4.010135043264214e-96
  },
  {
    "wavelengthUm": 3,
    "temperatureK": 250,
    "energy": 0.002285334161165835,
    "photon": 3.451391568928875e+16
  },
  {
    "wavelengthUm": 3.7,
    "temperatureK": 250,
    "energy": 0.030182335903642214,
    "photon": 5.621831697127584e+17
  },
  {
    "wavelengthUm": 4,
    "temperatureK": 250,
    "energy": 0.06562950572397637,
    "photon": 1.3215463283388342e+18
  },
  {
    "wavelengthUm": 4.8,
    "temperatureK": 250,
    "energy": 0.2901461317558713,
    "photon": 7.011021354627175e+18
  },
  {
    "wavelengthUm": 5,
    "temperatureK": 250,
    "energy": 0.38217202657434735,
    "photon": 9.619492653146472e+18
  },
  {
    "wavelengthUm": 10,
    "temperatureK": 250,
    "energy": 3.783497059499411,
    "photon": 1.9046565230475107e+20
  },
  {
    "wavelengthUm": 1000,
    "temperatureK": 250,
    "energy": 2.0105598216061657e-06,
    "photon": 1.0121392507983314e+16
  },
  {
    "wavelengthUm": 0.2,
    "temperatureK": 255,
    "energy": 1.1235931986550016e-111,
    "photon": 1.13125982730549e-93
  },
  {
    "wavelengthUm": 3,
    "temperatureK": 255,
    "energy": 0.003328970425458002,
    "photon": 5.027527551497349e+16
  },
  {
    "wavelengthUm": 3.7,
    "temperatureK": 255,
    "energy": 0.04094558792496391,
    "photon": 7.626619914010989e+17
  },
  {
    "wavelengthUm": 4,
    "temperatureK": 255,
    "energy": 0.08702006065773096,
    "photon": 1.75227651626262e+18
  },
  {
    "wavelengthUm": 4.8,
    "temperatureK": 255,
    "energy": 0.3670435863074343,
    "photon": 8.869152954434627e+18
  },
  {
    "wavelengthUm": 5,
    "temperatureK": 255,
    "energy": 0.478934511065926,
    "photon": 1.2055060784624724e+19
  },
  {
    "wavelengthUm": 10,
    "temperatureK": 255,
    "energy": 4.2370764830802745,
    "photon": 2.1329936921420005e+20
  },
  {
    "wavelengthUm": 1000,
    "temperatureK": 255,
    "energy": 2.0519394388644652e-06,
    "photon": 1.0329702324781896e+16
  },
  {
    "wavelengthUm": 0.2,
    "temperatureK": 260,
    "energy": 2.551327353907833e-109,
    "photon": 2.5687358603064647e-91
  },
  {
    "wavelengthUm": 3,
    "temperatureK": 260,
    "energy": 0.004779550747028151,
    "photon": 7.218244680307664e+16
  },
  {
    "wavelengthUm": 3.7,
    "temperatureK": 260,
    "energy": 0.054899323016070055,
    "photon": 1.0225674887056851e+18
  },
  {
    "wavelengthUm": 4,
    "temperatureK": 260,
    "energy": 0.11413723228231405,
    "photon": 2.298320528023471e+18
  },
  {
    "wavelengthUm": 4.8,
    "temperatureK": 260,
    "energy": 0.46014183113595,
    "photon": 1.1118756554596442e+19
  },
  {
    "wavelengthUm": 5,
    "temperatureK": 260,
    "energy": 0.5950092790853396,
    "photon": 1.4976730348425759e+19
  },
  {
    "wavelengthUm": 10,
    "temperatureK": 260,
    "energy": 4.724616391676829,
    "photon": 2.3784269652624176e+20
  },
  {
    "wavelengthUm": 1000,
    "temperatureK": 260,
    "energy": 2.093319486766137e-06,
    "photon": 1.0538014309489412e+16
  },
  {
    "wavelengthUm": 0.2,
    "temperatureK": 270,
    "energy": 7.199214626570891e-105,
    "photon": 7.248337124983263e-87
  },
  {
    "wavelengthUm": 3,
    "temperatureK": 270,
    "energy": 0.009464296633276179,
    "photon": 1.429331174451429e+17
  },
  {
    "wavelengthUm": 3.7,
    "temperatureK": 270,
    "energy": 0.0955290992765642,
    "photon": 1.7793470989971612e+18
  },
  {
    "wavelengthUm": 4,
    "temperatureK": 270,
    "energy": 0.19052570140981837,
    "photon": 3.836514360039448e+18
  },
  {
    "wavelengthUm": 4.8,
    "temperatureK": 270,
    "energy": 0.7052324421610692,
    "photon": 1.7041067141047892e+19
  },
  {
    "wavelengthUm": 5,
    "temperatureK": 270,
    "energy": 0.8964951229382021,
    "photon": 2.2565304755522204e+19
  },
  {
    "wavelengthUm": 10,
    "temperatureK": 270,
    "energy": 5.804555666823692,
    "photon": 2.9220809849581063e+20
  },
  {
    "wavelengthUm": 1000,
    "temperatureK": 270,
    "energy": 2.1760807788199916e-06,
    "photon": 1.0954644300968962e+16
  },
  {
    "wavelengthUm": 0.2,
    "temperatureK": 280,
    "energy": 9.770343829059844e-101,
    "photon": 9.837009948091766e-83
  },
  {
    "wavelengthUm": 3,
    "temperatureK": 280,
    "energy": 0.017848292152331767,
    "photon": 2.6955114967918762e+17
  },
  {
    "wavelengthUm": 3.7,
    "temperatureK": 280,
    "energy": 0.159779466116866,
    "photon": 2.9760892928685635e+18
  },
  {
    "wavelengthUm": 4,
    "temperatureK": 280,
    "energy": 0.3066092401613176,
    "photon": 6.174026622631081e+18
  },
  {
    "wavelengthUm": 4.8,
    "temperatureK": 280,
    "energy": 1.0484027894761616,
    "photon": 2.5333352889407697e+19
  },
  {
    "wavelengthUm": 5,
    "temperatureK": 280,
    "energy": 1.3117698723518139,
    "photon": 3.3018012236048253e+19
  },
  {
    "wavelengthUm": 10,
    "temperatureK": 280,
    "energy": 7.028544375847933,
    "photon": 3.538251168816521e+20
  },
  {
    "wavelengthUm": 1000,
    "temperatureK": 280,
    "energy": 2.258843523490144e-06,
    "photon": 1.1371281605088284e+16
  },
  {
    "wavelengthUm": 0.2,
    "temperatureK": 290.25,
    "energy": 8.51764371261688e-97,
    "photon": 8.575762266022125e-79
  },
  {
    "wavelengthUm": 3,
    "temperatureK": 290.25,
    "energy": 0.03268064761488832,
    "photon": 4.9355456878840326e+17
  },
  {
    "wavelengthUm": 3.7,
    "temperatureK": 290.25,
    "energy": 0.26092538693349965,
    "photon": 4.860056609041364e+18
  },
  {
    "wavelengthUm": 4,
    "temperatureK": 290.25,
    "energy": 0.4826211800541127,
    "photon": 9.718285113429686e+18
  },
  {
    "wavelengthUm": 4.8,
    "temperatureK": 290.25,
    "energy": 1.530087887839294,
    "photon": 3.6972675772647465e+19
  },
  {
    "wavelengthUm": 5,
    "temperatureK": 290.25,
    "energy": 1.8857346317247654,
    "photon": 4.7465039757773455e+19
  },
  {
    "wavelengthUm": 10,
    "temperatureK": 290.25,
    "energy": 8.436917677349951,
    "photon": 4.2472427058541344e+20
  },
  {
    "wavelengthUm": 1000,
    "temperatureK": 290.25,
    "energy": 2.3436766872306877e-06,
    "photon": 1.1798341640151618e+16
  },
  {
    "wavelengthUm": 0.2,
    "temperatureK": 300,
    "energy": 2.6830845242298783e-93,
    "photon": 2.7013920511086157e-75
  },
  {
    "wavelengthUm": 3,
    "temperatureK": 300,
    "energy": 0.055912854795379975,
    "photon": 8.444154859920965e+17
  },
  {
    "wavelengthUm": 3.7,
    "temperatureK": 300,
    "energy": 0.4032875342153273,
    "photon": 7.511726892664259e+18
  },
  {
    "wavelengthUm": 4,
    "temperatureK": 300,
    "energy": 0.7219764225707694,
    "photon": 1.4538053880954907e+19
  },
  {
    "wavelengthUm": 4.8,
    "temperatureK": 300,
    "energy": 2.1403518245350606,
    "photon": 5.171894678525863e+19
  },
  {
    "wavelengthUm": 5,
    "temperatureK": 300,
    "energy": 2.6026833955405264,
    "photon": 6.5511058007794385e+19
  },
  {
    "wavelengthUm": 10,
    "temperatureK": 300,
    "energy": 9.924033330070692,
    "photon": 4.995874060375491e+20
  },
  {
    "wavelengthUm": 1000,
    "temperatureK": 300,
    "energy": 2.424372789729416e-06,
    "photon": 1.220457522667659e+16
  },
  {
    "wavelengthUm": 0.2,
    "temperatureK": 500,
    "energy": 1.2175634250152218e-51,
    "photon": 1.2258712419806346e-33
  },
  {
    "wavelengthUm": 3,
    "temperatureK": 500,
    "energy": 33.47072267927635,
    "photon": 5.054865587021177e+20
  },
  {
    "wavelengthUm": 3.7,
    "temperatureK": 500,
    "energy": 72.03074121926704,
    "photon": 1.341661246653887e+21
  },
  {
    "wavelengthUm": 4,
    "temperatureK": 500,
    "energy": 87.4358489299433,
    "photon": 1.7606490227815563e+21
  },
  {
    "wavelengthUm": 4.8,
    "temperatureK": 500,
    "energy": 116.74842364821743,
    "photon": 2.8210808338655347e+21
  },
  {
    "wavelengthUm": 5,
    "temperatureK": 500,
    "energy": 121.07190590398115,
    "photon": 3.047450436876017e+21
  },
  {
    "wavelengthUm": 10,
    "temperatureK": 500,
    "energy": 71.01907122824913,
    "photon": 3.575182830816247e+21
  },
  {
    "wavelengthUm": 1000,
    "temperatureK": 500,
    "energy": 4.079815028405905e-06,
    "photon": 2.0538264427007896e+16
  },
  {
    "wavelengthUm": 0.2,
    "temperatureK": 800,
    "energy": 3.2921058520302974e-28,
    "photon": 3.3145689223620055e-10
  },
  {
    "wavelengthUm": 3,
    "temperatureK": 800,
    "energy": 1224.1959507535325,
    "photon": 1.848823535282117e+22
  },
  {
    "wavelengthUm": 3.7,
    "temperatureK": 800,
    "energy": 1340.6210773177086,
    "photon": 2.497071827165152e+22
  },
  {
    "wavelengthUm": 4,
    "temperatureK": 800,
    "energy": 1311.694052507762,
    "photon": 2.641288304510625e+22
  },
  {
    "wavelengthUm": 4.8,
    "temperatureK": 800,
    "energy": 1129.4558873005558,
    "photon": 2.729190045392822e+22
  },
  {
    "wavelengthUm": 5,
    "temperatureK": 800,
    "energy": 1074.0247818926669,
    "photon": 2.7033829742386593e+22
  },
  {
    "wavelengthUm": 10,
    "temperatureK": 800,
    "energy": 236.29905207630114,
    "photon": 1.1895569729519448e+22
  },
  {
    "wavelengthUm": 1000,
    "temperatureK": 800,
    "energy": 6.563156872638483e-06,
    "photon": 3.3039696747931184e+16
  },
  {
    "wavelengthUm": 0.2,
    "temperatureK": 1500,
    "energy": 5.525210557279469e-10,
    "photon": 556291080.1112492
  },
  {
    "wavelengthUm": 3,
    "temperatureK": 1500,
    "energy": 20887.343058818646,
    "photon": 3.154479592330415e+23
  },
  {
    "wavelengthUm": 3.7,
    "temperatureK": 1500,
    "energy": 13894.450584342736,
    "photon": 2.5880125036911004e+23
  },
  {
    "wavelengthUm": 4,
    "temperatureK": 1500,
    "energy": 11630.432202886135,
    "photon": 2.3419580576092537e+23
  },
  {
    "wavelengthUm": 4.8,
    "temperatureK": 1500,
    "energy": 7330.572641225009,
    "photon": 1.7713419447727745e+23
  },
  {
    "wavelengthUm": 5,
    "temperatureK": 1500,
    "energy": 6560.137761200103,
    "photon": 1.651224909450999e+23
  },
  {
    "wavelengthUm": 10,
    "temperatureK": 1500,
    "energy": 739.9769229442496,
    "photon": 3.7251300873929216e+22
  },
  {
    "wavelengthUm": 1000,
    "temperatureK": 1500,
    "energy": 1.2357787774096355e-05,
    "photon": 6.22105441717552e+16
  },
  {
    "wavelengthUm": 0.2,
    "temperatureK": 2000,
    "energy": 8.901352256730614e-05,
    "photon": 89620889738282.53
  },
  {
    "wavelengthUm": 3,
    "temperatureK": 2000,
    "energy": 49010.54557924029,
    "photon": 7.40174398454282e+23
  },
  {
    "wavelengthUm": 3.7,
    "temperatureK": 2000,
    "energy": 28680.51882789464,
    "photon": 5.342099774897326e+23
  },
  {
    "wavelengthUm": 4,
    "temperatureK": 2000,
    "energy": 23076.07930432627,
    "photon": 4.646706925593533e+23
  },
  {
    "wavelengthUm": 4.8,
    "temperatureK": 2000,
    "energy": 13447.56475072572,
    "photon": 3.2494372082271216e+23
  },
  {
    "wavelengthUm": 5,
    "temperatureK": 2000,
    "energy": 11852.881963906739,
    "photon": 2.9834394733815537e+23
  },
  {
    "wavelengthUm": 10,
    "temperatureK": 2000,
    "energy": 1130.9046489110633,
    "photon": 5.693105829394254e+22
  },
  {
    "wavelengthUm": 1000,
    "temperatureK": 2000,
    "energy": 1.649684554700694e-05,
    "photon": 8.30470434803808e+16
  },
  {
    "wavelengthUm": 0.2,
    "temperatureK": 3000,
    "energy": 14.34046199326573,
    "photon": 1.4438311461303112e+19
  },
  {
    "wavelengthUm": 3,
    "temperatureK": 3000,
    "energy": 124202.52711887547,
    "photon": 1.875749998499411e+24
  },
  {
    "wavelengthUm": 3.7,
    "temperatureK": 3000,
    "energy": 64683.71018372213,
    "photon": 1.2048137472182246e+24
  },
  {
    "wavelengthUm": 4,
    "temperatureK": 3000,
    "energy": 50205.48858426381,
    "photon": 1.0109611274544753e+24
  },
  {
    "wavelengthUm": 4.8,
    "temperatureK": 3000,
    "energy": 27240.216794945187,
    "photon": 6.582260480202659e+23
  },
  {
    "wavelengthUm": 5,
    "temperatureK": 3000,
    "energy": 23679.261534215988,
    "photon": 5.9602081398286745e+23
  },
  {
    "wavelengthUm": 10,
    "temperatureK": 3000,
    "energy": 1935.3472255278816,
    "photon": 9.742763531977725e+22
  },
  {
    "wavelengthUm": 1000,
    "temperatureK": 3000,
    "energy": 2.477498489332888e-05,
    "photon": 1.2472016191212726e+17
  },
  {
    "wavelengthUm": 0.2,
    "temperatureK": 5772,
    "energy": 1438751.6379983893,
    "photon": 1.4485686914853804e+24
  },
  {
    "wavelengthUm": 3,
    "temperatureK": 5772,
    "energy": 378378.9727774594,
    "photon": 5.714411567006401e+24
  },
  {
    "wavelengthUm": 3.7,
    "temperatureK": 5772,
    "energy": 178640.32475935368,
    "photon": 3.327396008458408e+24
  },
  {
    "wavelengthUm": 4,
    "temperatureK": 5772,
    "energy": 134491.8064483794,
    "photon": 2.7081897241621364e+24
  },
  {
    "wavelengthUm": 4.8,
    "temperatureK": 5772,
    "energy": 68653.02707782743,
    "photon": 1.6589152369173565e+24
  },
  {
    "wavelengthUm": 5,
    "temperatureK": 5772,
    "energy": 58970.69397547614,
    "photon": 1.4843267377071774e+24
  },
  {
    "wavelengthUm": 10,
    "temperatureK": 5772,
    "energy": 4207.349474735924,
    "photon": 2.1180287696210226e+23
  },
  {
    "wavelengthUm": 1000,
    "temperatureK": 5772,
    "energy": 4.772203027608804e-05,
    "photon": 2.402382632496296e+17
  },
  {
    "wavelengthUm": 0.2,
    "temperatureK": 5778,
    "energy": 1457493.4590974404,
    "photon": 1.4674383939055113e+24
  },
  {
    "wavelengthUm": 3,
    "temperatureK": 5778,
    "energy": 378958.1109216912,
    "photon": 5.72315791378672e+24
  },
  {
    "wavelengthUm": 3.7,
    "temperatureK": 5778,
    "energy": 178895.55426018537,
    "photon": 3.3321499721754595e+24
  },
  {
    "wavelengthUm": 4,
    "temperatureK": 5778,
    "energy": 134679.67340912778,
    "photon": 2.711972700880526e+24
  },
  {
    "wavelengthUm": 4.8,
    "temperatureK": 5778,
    "energy": 68744.52096938192,
    "photon": 1.661126073310813e+24
  },
  {
    "wavelengthUm": 5,
    "temperatureK": 5778,
    "energy": 59048.540307286414,
    "photon": 1.4862861752506198e+24
  },
  {
    "wavelengthUm": 10,
    "temperatureK": 5778,
    "energy": 4212.290760805612,
    "photon": 2.1205162706278615e+23
  },
  {
    "wavelengthUm": 1000,
    "temperatureK": 5778,
    "energy": 4.7771699229278116e-05,
    "photon": 2.4048830254977626e+17
  }
];
function bandSettings(band) {
    if (band.samples) return {...band, response: radiometry.tabulatedResponse(band.samples)};
    if (band.kind === "step") return {...band, response: wavelength => wavelength >= band.edgeUm ? 0.7 : 0.15};
    return band;
}
function relative(actual, expected, tolerance = 2e-10) {
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance * Math.max(Math.abs(expected), 1e-280));
}
test.each(bandFixtures)("band $bandIndex at $temperatureK K", fixture => {
    const actual = radiometry.inBandRadiance(fixture.temperatureK, bandSettings(bands[fixture.bandIndex]));
    relative(actual.energy, fixture.energy); relative(actual.photon, fixture.photon);
});
test.each(spectralFixtures)("spectrum $wavelengthUm um at $temperatureK K", fixture => {
    relative(radiometry.planckEnergy(fixture.wavelengthUm, fixture.temperatureK), fixture.energy, 3e-12);
    relative(radiometry.planckPhoton(fixture.wavelengthUm, fixture.temperatureK), fixture.photon, 3e-12);
});
test("independent Stefan-Boltzmann integrated exitance", () => {
    for (const [temperature, expected] of [[180,59.525322502830484],[300,459.30032795393896],[1500,287062.70497121185],[3000,4593003.27953939]]) {
        const count = 16384, lower = Math.log(1 / temperature), step = Math.log(1e8) / count;
        let total = 0;
        for (let sample = 0; sample <= count; sample++) {
            const wavelength = Math.exp(lower + sample * step);
            total += (sample === 0 || sample === count ? 1 : sample % 2 === 0 ? 2 : 4) * radiometry.planckEnergy(wavelength, temperature) * wavelength;
        }
        relative(Math.PI * total * step / 3, expected, 1e-9);
    }
});
test("inverse temperature uses independent photon and energy fixtures", () => {
    for (const fixture of bandFixtures.filter(row => [180,300,800,3000].includes(row.temperatureK)))
        for (const quantity of ["energy", "photon"]) expect(Math.abs(radiometry.apparentTemperature(fixture[quantity],
            {quantity, band: bandSettings(bands[fixture.bandIndex])}) - fixture.temperatureK)).toBeLessThan(2e-6);
});
test("gray body reflection, solar dilution, and isothermal enclosure", () => {
    const environment = radiometry.inBandRadiance(300), solar = radiometry.solarIrradiance();
    relative(solar.energy, 21.81743295221056);
    relative(solar.photon, 4.064726720639015e20);
    for (const emissivity of [0,0.1,0.5,0.9,1]) {
        for (const quantity of ["energy", "photon"]) {
            relative(radiometry.grayBodyRadiance({temperatureK:300, emissivity, environment}).total[quantity], environment[quantity]);
            relative(radiometry.grayBodyRadiance({temperatureK:300, emissivity, environment, solar, cosIncidence:0.5}).total[quantity],
                environment[quantity] + (1-emissivity)*solar[quantity]*0.5/Math.PI);
            relative(radiometry.solarIrradiance({distanceM:2*radiometry.AU_M})[quantity], solar[quantity]/4);
        }
    }
});
test("non-finite and unphysical radiometry inputs fail explicitly", () => {
    for (const value of [NaN,Infinity,-1]) expect(() => radiometry.inBandRadiance(value)).toThrow();
    expect(() => radiometry.inBandRadiance(300,{minUm:5,maxUm:3})).toThrow();
    expect(() => radiometry.grayBodyRadiance({temperatureK:300,emissivity:1.1})).toThrow();
    expect(() => radiometry.inBandRadiance(300,{response:-0.1})).toThrow();
    expect(() => radiometry.inBandRadiance(300,{response:() => -1})).toThrow();
});
test("cold allowed temperatures converge without a subnormal quadrature failure", () => {
    for (let t = 0; t <= 10; t += .1) for (const band of [{minUm: 3, maxUm: 5}, {minUm: 3.7, maxUm: 5}]) {
        const result = radiometry.inBandRadiance(t, band);
        expect(Number.isFinite(result.photon)).toBe(true);
        expect(result.photon).toBeGreaterThanOrEqual(0);
        expect(result.photon).toBeLessThan(1e-90);
    }
});
