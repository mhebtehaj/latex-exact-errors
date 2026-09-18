'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
// Independent fallback vocabulary. Installed Workshop completion data is read
// at runtime, never copied into this extension (see METADATA.md).
const CORE = `begin end documentclass usepackage RequirePackage LoadClass input include includeonly subfile newcommand renewcommand providecommand DeclareRobustCommand DeclareMathOperator newenvironment renewenvironment provideenvironment newtheorem def gdef edef xdef let newif newlength newsavebox newcount newdimen newtoks NewDocumentCommand RenewDocumentCommand ProvideDocumentCommand DeclareDocumentCommand NewExpandableDocumentCommand RenewExpandableDocumentCommand ProvideExpandableDocumentCommand DeclareExpandableDocumentCommand NewDocumentEnvironment RenewDocumentEnvironment ProvideDocumentEnvironment DeclareDocumentEnvironment section subsection subsubsection paragraph subparagraph chapter part title author date thanks maketitle tableofcontents label ref pageref eqref cite nocite bibliography bibliographystyle item emph textbf textit texttt textrm textsf textsc textsl textup textnormal text mbox hbox vbox ensuremath footnote footnotemark footnotetext caption includegraphics centering centerline raggedright noindent indent par newline linebreak pagebreak newpage clearpage cleardoublepage smallskip medskip bigskip vspace hspace quad qquad enspace thinspace negthinspace hfill vfill rule hrule vrule textwidth linewidth columnwidth baselineskip parskip parindent setlength addtolength setcounter addtocounter stepcounter refstepcounter value arabic roman Roman alph Alph thepage pagestyle thispagestyle pagenumbering markboth markright tiny scriptsize footnotesize small normalsize large Large LARGE huge Huge bfseries itshape normalfont rmfamily sffamily ttfamily slshape scshape upshape normalshape textbackslash textasciitilde textasciicircum textunderscore textbraceleft textbraceright textpercent textdollar textampersand LaTeX TeX today relax protect robust noexpand expandafter csname endcsname catcode makeatletter makeatother ExplSyntaxOn ExplSyntaxOff begingroup endgroup bgroup egroup global long outer if ifx ifnum ifdim ifodd ifcat ifcase ifdefined ifcsname iftrue iffalse else or fi unless endinput errorcontextlines typeout message write openout closeout special jobname detokenize unexpanded scantokens string meaning loop repeat advance multiply divide count dimen skip toks newbox setbox box copy number the numexpr dimexpr gluestretch glueshrink font selectfont fontsize fontfamily fontseries fontshape fontencoding left right middle big Big bigg Bigg bigl bigr Bigl Bigr biggl biggr Biggl Biggr lbrace rbrace langle rangle lvert rvert vert Vert lVert rVert lfloor rfloor lceil rceil frac sqrt over atop choose binom sum prod coprod int iint oint lim limsup liminf sup inf max min sin cos tan cot sec csc arcsin arccos arctan sinh cosh tanh log ln exp det dim gcd hom ker deg Pr mod bmod pmod mathrm mathbf mathit mathsf mathtt mathcal mathnormal mathop mathbin mathrel mathord mathopen mathclose mathpunct mathchoice displaystyle textstyle scriptstyle scriptscriptstyle limits nolimits overline underline overbrace underbrace hat widehat tilde widetilde bar vec dot ddot acute grave breve check alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi omicron pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega infty partial nabla ell hbar imath jmath Re Im aleph emptyset forall exists neg land lor lnot wedge vee cap cup in notin ni subset supset subseteq supseteq setminus le ge leq geq neq ne equiv sim simeq approx cong propto ll gg prec succ preceq succeq pm mp times div cdot circ bullet ast star oplus otimes odot oslash ominus bigcup bigcap bigvee bigwedge bigoplus bigotimes to gets mapsto rightarrow leftarrow leftrightarrow Rightarrow Leftarrow Leftrightarrow longrightarrow longleftarrow Longrightarrow Longleftarrow hookrightarrow uparrow downarrow updownarrow dots ldots cdots vdots ddots prime angle triangle triangleleft triangleright bot top perp parallel mid not colon iff surd flat natural sharp clubsuit diamondsuit heartsuit spadesuit wp t S P H O L o l ae AE oe OE aa AA ss i j c u v b d r accent verb lstinline multicolumn hline cline tabularnewline cr crcr omit span halign valign`;
const FALLBACK = {
  dsfont: 'mathds', bbm: 'mathbbm mathbbmss mathbbmtt',
  amstext: 'text', amsbsy: 'boldsymbol pmb', amsopn: 'operatorname DeclareMathOperator',
  amsmath: 'dfrac tfrac binom dbinom tbinom cfrac genfrac overset underset sideset substack boxed text intertext numberwithin tag notag nonumber eqref operatorname DeclareMathOperator allowdisplaybreaks displaybreak',
  amssymb: 'mathbb mathfrak varnothing leqslant geqslant nleq nsubseteq lesssim gtrsim blacksquare square checkmark therefore because',
  amsthm: 'newtheorem theoremstyle qed qedsymbol qedhere',
  thmtools: 'declaretheorem declaretheoremstyle listoftheorems',
  mathtools: 'coloneqq eqqcolon mathclap mathllap mathrlap DeclarePairedDelimiter DeclarePairedDelimiterX shortintertext',
  hyperref: 'href url autoref hyperref hypersetup phantomsection texorpdfstring pdfstringdef DisableHyper',
  cleveref: 'cref Cref crefrange Crefrange crefname Crefname',
  graphicx: 'includegraphics graphicspath resizebox scalebox rotatebox reflectbox',
  xcolor: 'color textcolor colorbox fcolorbox definecolor providecolor colorlet pagecolor',
  physics: 'ket bra braket ketbra expval matrixel mel innerproduct outerproduct norm abs qty quantity pqty bqty Bqty vqty dv pdv dd eval comm anticommutator order',
  xparse: '', amsfonts: 'mathbb mathfrak', bm: 'bm', cancel: 'cancel bcancel xcancel cancelto'
};
const DEPENDENCIES = { amsmath: ['amstext', 'amsbsy', 'amsopn'], amssymb: ['amsfonts'], mathtools: ['amsmath'], physics: ['amsmath', 'xparse'] };
class Metadata {
  constructor(directory) { this.directory = directory; this.cache = new Map(); }
  async load(name, trail = new Set()) {
    if (trail.has(name)) return { names: [], missing: [] };
    if (!/^[a-zA-Z0-9_.+-]+$/.test(name)) return { names: [], missing: [name] };
    if (this.cache.has(name)) return this.cache.get(name);
    const next = new Set([...trail, name]);
    let data;
    if (this.directory) try { data = JSON.parse(await fs.readFile(path.join(this.directory, 'packages', name + '.json'), 'utf8')); } catch { /* Missing metadata is uncertainty. */ }
    const fallback = FALLBACK[name];
    const names = new Set((fallback || '').split(/\s+/).filter(Boolean));
    for (const macro of data?.macros || []) if (/^[a-zA-Z@_:]+$/.test(macro.name)) names.add(macro.name);
    const deps = new Set([...(DEPENDENCIES[name] || []), ...(data?.deps || []).map(d => d.name)]);
    const missing = [];
    for (const dep of deps) { const info = await this.load(dep, next); info.names.forEach(n => names.add(n)); missing.push(...info.missing); }
    const standardClass = /^class-(article|report|book|letter|slides)$/.test(name);
    if (!data && fallback === undefined && !standardClass) missing.push(name);
    const result = { names: [...names], missing };
    this.cache.set(name, result); return result;
  }
  async base() {
    const names = new Set(CORE.split(/\s+/));
    for (const pkg of ['tex', 'latex-document']) (await this.load(pkg)).names.forEach(n => names.add(n));
    return names;
  }
}
module.exports = { Metadata };
