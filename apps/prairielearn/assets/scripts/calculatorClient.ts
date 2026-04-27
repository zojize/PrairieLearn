import {
  ComputeEngine,
  type Expression,
  type MathJsonExpression,
  isTensor,
} from '@cortex-js/compute-engine';
import { MathfieldElement } from 'mathlive';

import { onDocumentReady } from '@prairielearn/browser-utils';

interface DrawerElements {
  drawer: HTMLElement;
  fab: HTMLElement;
  fabClose: HTMLElement | null;
}

type DisplayMode = 'numeric' | 'symbolic';
type AngleMode = 'rad' | 'deg';

interface HistoryItem {
  input: string;
  displayed: string;
  angleMode: AngleMode;
}

interface CalculatorLocalData {
  variable: { name: string; value: string }[];
  history: HistoryItem[];
  temp_input: string | null;
  isOpen: boolean;
}

const DEFAULT_CALCULATOR_DATA: CalculatorLocalData = {
  variable: [],
  history: [],
  temp_input: null,
  isOpen: false,
};

function getCalculatorData(storageKey: string): CalculatorLocalData {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return { ...DEFAULT_CALCULATOR_DATA };
  try {
    return JSON.parse(raw);
  } catch {
    localStorage.removeItem(storageKey);
    return { ...DEFAULT_CALCULATOR_DATA };
  }
}

function setCalculatorData(storageKey: string, data: CalculatorLocalData) {
  localStorage.setItem(storageKey, JSON.stringify(data));
}

const TRIG_FUNCTIONS = new Set([
  'Sin',
  'Cos',
  'Tan',
  'Cot',
  'Sec',
  'Csc',
  'Sinh',
  'Cosh',
  'Tanh',
  'Coth',
  'Sech',
  'Csch',
]);

const INVERSE_TRIG_FUNCTIONS = new Set([
  'Arcsin',
  'Arccos',
  'Arctan',
  'Arctan2',
  'Acot',
  'Asec',
  'Acsc',
  'Arsinh',
  'Arcosh',
  'Artanh',
  'Arcoth',
  'Asech',
  'Acsch',
]);

function toBaseString(n: number, base: number): string {
  if (!Number.isInteger(n)) return '';
  const str = Math.abs(n).toString(base).toUpperCase();
  if (base === 2) {
    // Nibble grouping
    const padded = str.padStart(Math.ceil(str.length / 4) * 4, '0');
    return (n < 0 ? '-' : '') + padded.replaceAll(/(.{4})/g, '$1 ').trim();
  }
  return (n < 0 ? '-' : '') + str;
}

const BASE_LABELS: Record<number, string> = {
  2: 'BIN',
  8: 'OCT',
  10: 'DEC',
  16: 'HEX',
};

function updateBaseDisplay(result: number, activeBase: number) {
  const display = document.getElementById('base-display');
  if (!display) return;

  display.querySelectorAll<HTMLElement>('.base-value').forEach((el) => {
    const base = Number(el.dataset.base);
    el.textContent = `${BASE_LABELS[base]}: ${toBaseString(result, base)}`;
    el.classList.toggle('active', base === activeBase);
  });
}

export function initCalculator(storageKey: string, { drawer, fab, fabClose }: DrawerElements) {
  const featuresAttr = drawer.dataset.features;
  const defaultFeatures = ['scientific', 'abc', 'func'];
  let features: string[];
  try {
    features = featuresAttr ? JSON.parse(featuresAttr) : defaultFeatures;
  } catch {
    features = defaultFeatures;
  }
  initColumnNavigation(drawer);
  initDrawerUI(drawer, fab, fabClose, storageKey);
  const ce = new ComputeEngine();
  ce.timeLimit = 500;
  ce.pushScope();
  const calculatorInputElement = ensureElement(
    drawer.querySelector<MathfieldElement>('#calculator-input'),
  );
  const calculatorInputGroup = ensureElement(
    calculatorInputElement.closest<HTMLElement>('.calculator-input-group'),
  );
  const calculatorOutput = ensureElement(
    drawer.querySelector<MathfieldElement>('#calculator-output'),
  );
  const copyButton = ensureElement(drawer.querySelector<HTMLElement>('#calculator-output-copy'));
  const historyPanel = ensureElement(drawer.querySelector<HTMLElement>('#history-panel'));
  const clearHistoryBtn = ensureElement(
    drawer.querySelector<HTMLElement>('#calculatorClearHistory'),
  );
  const historyTemplate = ensureElement(
    drawer.querySelector<HTMLTemplateElement>('#history-item-template'),
  );
  const displayModeSwitch = ensureElement(drawer.querySelector<HTMLElement>('#displayModeSwitch'));
  const angleModeSwitch = ensureElement(drawer.querySelector<HTMLElement>('#angleModeSwitch'));

  const onExport = (_mf: unknown, latex: string) => {
    return ce.parse(latex).toString();
  };
  calculatorInputElement.onExport = onExport;
  calculatorOutput.onExport = onExport;

  MathfieldElement.soundsDirectory = null;
  calculatorInputElement.menuItems = [];
  // Prevent MathLive's built-in virtual keyboard from appearing on touch devices,
  // since the calculator provides its own custom on-screen keyboard.
  // Note: the HTML attribute `math-virtual-keyboard-policy` doesn't seem to work, so we set it here via JS.
  calculatorInputElement.mathVirtualKeyboardPolicy = 'manual';
  calculatorOutput.dataset.displayMode = 'numeric';
  calculatorOutput.dataset.angleMode = 'rad';

  // Auto-insert ans: after submitting to history, the next operator/function
  // input automatically prefixes with ans (classic calculator behavior).
  let shouldAutoInsertAns = false;
  const autoAnsButtons = new Set([
    'plus',
    'minus',
    'mul',
    'div',
    'sqr',
    'apowerb',
    'perc',
    'factorial',
    'inv',
    'sin',
    'cos',
    'tan',
    'sin-1',
    'cos-1',
    'tan-1',
    'sinh',
    'cosh',
    'tanh',
    'sinh-1',
    'cosh-1',
    'tanh-1',
    'sqrt',
    'root',
    'abs',
    'ln',
    'lg',
    'log',
    'epowerx',
    'round',
  ]);
  const autoAnsKeys = new Set(['+', '-', '*', '/', '^', '!']);

  drawer.querySelectorAll<HTMLButtonElement>('[data-key="calculate"]').forEach((button) => {
    prepareButton(button);
    button.addEventListener('click', () => {
      calculate(true);
    });
  });

  let typingTimer: ReturnType<typeof setTimeout>;
  const delay = 200;
  calculatorInputElement.addEventListener('input', () => {
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      calculate(false);
    }, delay);
  });

  // Data from localStorage
  const calculatorLocalData = localStorage.getItem(storageKey);
  if (!calculatorLocalData) {
    setCalculatorData(storageKey, { ...DEFAULT_CALCULATOR_DATA, isOpen: true });
  } else {
    const data = getCalculatorData(storageKey);
    for (const historyItem of data.history) {
      addHistoryItem(historyItem);
    }
    for (const variable of data.variable) {
      ce.assign(variable.name, ce.parse(variable.value));
    }

    // Set ans to the last history item's result, or \bot if no history
    const items = Array.from(historyPanel.querySelectorAll<HTMLElement>('.history-item'));
    if (items.length > 0) {
      const displayMode = calculatorOutput.dataset.displayMode as DisplayMode;
      const lastResult = resolveAnsAndEvaluate(items, 0, displayMode);
      if (lastResult) {
        ce.assign('ans', lastResult.evaluated);
      } else {
        ce.assign('ans', ce.parse('\\bot'));
      }
    } else {
      ce.assign('ans', ce.parse('\\bot'));
    }

    if (data.temp_input) {
      calculatorInputElement.value = data.temp_input;
      calculatorInputElement.dispatchEvent(new CustomEvent('input'));
    }
  }

  /**
   * Resolves the correct `ans` value by recursively evaluating previous history
   * items, then evaluates the item at the given DOM index. Does not update the
   * DOM — only returns the result. Saves and restores the global `ans`.
   */
  function resolveAnsAndEvaluate(
    items: HTMLElement[],
    domIndex: number,
    displayMode: DisplayMode,
  ): ReturnType<typeof evaluateExpression> {
    const item = items[domIndex];
    const input = item.dataset.input!;
    const angleMode = item.dataset.angleMode! as AngleMode;

    const savedAns = ce.expr('ans').evaluate();

    // checking `{ans}` here because it could be \mathrm{ans} or \operatorname{ans}
    if (input.includes('{ans}') && domIndex + 1 < items.length) {
      const prevResult = resolveAnsAndEvaluate(items, domIndex + 1, displayMode);
      if (prevResult) {
        ce.assign('ans', prevResult.evaluated);
      }
    }

    const result = evaluateExpression(input, angleMode, displayMode);
    ce.assign('ans', savedAns);
    return result;
  }

  /**
   * Re-evaluates a history item with the correct `ans` context, updates its
   * displayed output, and forward-propagates to subsequent items that use `ans`.
   */
  function reevaluateHistoryItem(historyItemEl: HTMLElement, updateGlobalAns = true) {
    const items = Array.from(historyPanel.querySelectorAll<HTMLElement>('.history-item'));
    const domIndex = items.indexOf(historyItemEl);
    if (domIndex === -1) return;

    const displayMode = calculatorOutput.dataset.displayMode as DisplayMode;

    const result = resolveAnsAndEvaluate(items, domIndex, displayMode);
    if (result) {
      const outputField = ensureElement(
        historyItemEl.querySelector<MathfieldElement>(
          '.history-output .pl-calculator-history-text',
        ),
      );
      outputField.value = `=${result.displayed}`;
    }

    // Forward propagation: if the next item uses ans, re-evaluate it too
    if (domIndex > 0) {
      const nextItem = items[domIndex - 1];
      if (nextItem.dataset.input?.includes('{ans}')) {
        reevaluateHistoryItem(nextItem, false);
      }
    }

    // After all re-evaluations, set ans to the last history item's result
    if (updateGlobalAns && items.length > 0) {
      const lastResult = resolveAnsAndEvaluate(items, 0, displayMode);
      if (lastResult) {
        ce.assign('ans', lastResult.evaluated);
      }
    }
  }

  const BASE_RADIXES = new Set([2, 8, 10, 16]);

  /** Replace ["Subscript", value, base] with the decimal integer for bases 2/8/10/16. */
  function resolveBaseSubscripts(json: MathJsonExpression): MathJsonExpression {
    if (!Array.isArray(json)) return json;
    if (json[0] === 'Subscript' && json.length === 3) {
      const base = typeof json[2] === 'number' ? json[2] : undefined;
      if (base && BASE_RADIXES.has(base)) {
        // The value may be a number (e.g. 1010_{2}) or a string symbol (e.g. FF_{16})
        const raw =
          typeof json[1] === 'number'
            ? String(json[1])
            : typeof json[1] === 'string'
              ? json[1]
              : undefined;
        if (raw) {
          const parsed = Number.parseInt(raw, base);
          if (!Number.isNaN(parsed)) return parsed;
        }
      }
    }
    const [head, ...rest] = json;
    return [head, ...rest.map((item: MathJsonExpression) => resolveBaseSubscripts(item))] as const;
  }

  function evaluateExpression(
    input: string,
    angleMode: AngleMode = 'rad',
    displayMode: DisplayMode = 'numeric',
    latexOptions: { notation: string; fractionalDigits?: number } = { notation: 'auto' },
  ) {
    if (!input || input.length === 0) return null;

    let parsed = ce.parse(input, { parseNumbers: 'rational' });

    if (angleMode === 'deg') {
      parsed = ce.expr(radianToDegree(parsed.json));
    }

    // Convert base subscripts like FF_{16} or 1010_{2} to decimal
    if (features.includes('programmer')) {
      parsed = ce.expr(resolveBaseSubscripts(parsed.json));
    }

    const json = parsed.json;
    if (Array.isArray(json) && json[0] === 'Assign' && json[1] === 'InvisibleOperator') {
      return null;
    }

    try {
      const evaluated = parsed.evaluate();
      const numericValue = displayMode === 'symbolic' ? evaluated : evaluated.N();
      const displayed = numericValue.toLatex(latexOptions);

      return { displayed, evaluated };
    } catch (e) {
      console.error('Evaluation failed:', e);
      return null;
    }
  }

  function showCalculationError() {
    calculatorInputGroup.classList.add('error');
    calculatorOutput.value = '';
    copyButton.onclick = null;
  }

  function calculate(addToHistory = false) {
    const input = calculatorInputElement.value;
    if (input.length === 0) {
      calculatorOutput.value = '';
      copyButton.onclick = function () {
        void navigator.clipboard.writeText('');
      };
      calculatorInputGroup.classList.remove('error');
      lastIntegerResult = 0;
      refreshBaseDisplay();
      return;
    }

    const data = getCalculatorData(storageKey);

    // Reject expressions using `ans` when there is no prior history
    if (data.history.length === 0 && input.includes('{ans}')) {
      showCalculationError();
      return;
    }

    const angleMode = (calculatorOutput.dataset.angleMode ?? 'rad') as AngleMode;
    const displayMode = calculatorOutput.dataset.displayMode as DisplayMode;
    const result = evaluateExpression(input, angleMode, displayMode, {
      notation: 'adaptiveScientific',
      fractionalDigits: ce.precision,
    });

    if (!result) {
      showCalculationError();
      return;
    }

    const { displayed, evaluated } = result;

    if (hasError(evaluated.json)) {
      showCalculationError();
      return;
    }

    calculatorInputGroup.classList.remove('error');
    calculatorOutput.value = `=${displayed}`;

    // Update base conversion display for programmer mode
    if (features.includes('programmer')) {
      try {
        const numResult = Number(evaluated.N().valueOf());
        if (Number.isInteger(numResult)) {
          lastIntegerResult = numResult;
          refreshBaseDisplay();
        }
      } catch {
        // ignore non-numeric results
      }
    }

    copyButton.onclick = function () {
      window.bootstrap.Tooltip.getInstance(copyButton)?.hide();
      void navigator.clipboard.writeText(ce.parse(displayed).toString());
    };

    // Add to history
    if (addToHistory) {
      const parsed = ce.parse(input, { parseNumbers: 'rational' });
      const parsedJson = parsed.json;
      // FIXME: could be multiple assignments in one expression
      if (Array.isArray(parsedJson) && parsedJson[0] === 'Assign') {
        const varName = parsedJson[1] as string;
        const varVal = ce.expr(parsedJson[2]).evaluate();
        data.variable.push({
          name: varName,
          value: varVal.toLatex({ notation: 'auto' }),
        });
      }

      try {
        ce.assign('ans', evaluated);
        shouldAutoInsertAns = true;
      } catch (e) {
        console.error('Failed to assign ans:', e);
      }

      const historyItem: HistoryItem = {
        input,
        displayed,
        angleMode,
      };
      addHistoryItem(historyItem);
      data.history.push(historyItem);

      calculatorInputElement.value = '';
      calculatorOutput.value = '';
      lastIntegerResult = 0;
      refreshBaseDisplay();
    }
    data.temp_input = calculatorInputElement.value;
    setCalculatorData(storageKey, data);
  }

  // Clear history button
  clearHistoryBtn.addEventListener('click', () => {
    historyPanel.innerHTML = '';
    clearHistoryBtn.classList.add('d-none');

    const data = getCalculatorData(storageKey);
    data.history = [];
    data.variable = [];
    data.temp_input = null;
    setCalculatorData(storageKey, data);

    ce.popScope();
    ce.pushScope();
    shouldAutoInsertAns = false;
    // Clear the input and output fields
    calculatorInputElement.executeCommand('deleteAll');
    calculatorOutput.value = '';
    calculatorInputGroup.classList.remove('error');
  });

  registerCustomFunctions(ce);

  // Upper/lowercase switch
  drawer.querySelectorAll<HTMLButtonElement>('[data-key="shift"]').forEach((button) =>
    button.addEventListener('click', () => {
      button.classList.toggle('btn-light');
      button.classList.toggle('btn-secondary');
      drawer.querySelectorAll<HTMLButtonElement>('.btn-key[data-key]').forEach((btn) => {
        btn.classList.toggle('uppercase');
      });
    }),
  );

  // Backspace button
  drawer.querySelectorAll<HTMLButtonElement>('[data-key="backspace"]').forEach((button) => {
    prepareButton(button);
    button.addEventListener('click', () => {
      calculatorInputElement.executeCommand(['deleteBackward']);
      calculatorInputElement.focus();
    });
  });

  // Left/right
  drawer.querySelectorAll<HTMLButtonElement>('[data-key="left"]').forEach((button) => {
    prepareButton(button);
    button.addEventListener('click', () => {
      calculatorInputElement.executeCommand(['moveToPreviousChar']);
      calculatorInputElement.focus();
    });
  });
  drawer.querySelectorAll<HTMLButtonElement>('[data-key="right"]').forEach((button) => {
    prepareButton(button);
    button.addEventListener('click', () => {
      calculatorInputElement.executeCommand(['moveToNextChar']);
      calculatorInputElement.focus();
    });
  });

  // Clear all
  drawer.querySelectorAll<HTMLButtonElement>('[data-key="clear"]').forEach((button) => {
    prepareButton(button);
    button.addEventListener('click', () => {
      calculatorInputElement.executeCommand('deleteAll');
      calculatorInputElement.dispatchEvent(new CustomEvent('input'));
      calculatorInputElement.focus();
    });
  });

  // Other panel buttons
  const buttonActions: Record<string, string> = {
    div: '\\frac{#@}{#?}',
    frac: '\\frac{#0}{#?}',
    deg: '#@\\degree',
    sin: '\\sin(#0)',
    'sin-1': '\\sin^{-1}(#0)',
    cos: '\\cos(#0)',
    'cos-1': '\\cos^{-1}(#0)',
    tan: '\\tan(#0)',
    'tan-1': '\\tan^{-1}(#0)',
    sinh: '\\sinh(#0)',
    'sinh-1': '\\sinh^{-1}(#0)',
    cosh: '\\cosh(#0)',
    'cosh-1': '\\cosh^{-1}(#0)',
    tanh: '\\tanh(#0)',
    'tanh-1': '\\tanh^{-1}(#0)',
    ans: '\\operatorname{ans}',
    nPr: '\\operatorname{nPr}(#?,#?)',
    nCr: '\\operatorname{nCr}(#?,#?)',
    factorial: '#@!',
    mean: '\\operatorname{mean}([#?])',
    stdev: '\\operatorname{stdev}([#?])',
    stdevp: '\\operatorname{stdevp}([#?])',
    pi: '\\pi',
    e: 'e',
    epowerx: 'e^{#0}',
    apowerb: '#@^{#?}',
    sqrt: '\\sqrt{#0}',
    root: '\\sqrt[#?]{#0}',
    abs: '|#0|',
    round: '\\operatorname{round}(#0)',
    inv: '\\frac{1}{#@}',
    log: '\\log_{#?}{#0}',
    lg: '\\lg(#0)',
    ln: '\\ln(#0)',
    sqr: '#@^2',
    perc: '\\%',
    lpar: '(',
    rpar: ')',
    assign: '\\coloneqq',
    mul: '\\cdot',
    minus: '-',
    plus: '+',
    'dec-point': '.',
    lbra: '[',
    rbra: ']',
    eq: '=',
    'bitwise-and': '\\operatorname{and}',
    'bitwise-or': '\\operatorname{or}',
    'bitwise-xor': '\\veebar',
    'bitwise-not': '\\lnot',
    'bitwise-nand': '\\barwedge',
    'bitwise-nor': '\\operatorname{Nor}(#@,#?)',
    'left-shift': '\\operatorname{Lsh}(#@,#?)',
    'right-shift': '\\operatorname{Rsh}(#@,#?)',
  };

  setupButtonEvents(buttonActions);

  // Buttons for number and letter inputs
  const specialKeys = new Set(['backspace', 'left', 'right', 'calculate', 'shift', 'clear']);

  document.querySelectorAll<HTMLButtonElement>('.btn-key').forEach((button) => {
    const key = button.dataset.key;
    if (!key || key in buttonActions || specialKeys.has(key)) return;
    prepareButton(button);
    button.addEventListener('click', () => {
      shouldAutoInsertAns = false;
      const value = button.classList.contains('uppercase') ? key.toUpperCase() : key;
      calculatorInputElement.insert(value);
      calculatorInputElement.focus();
    });
  });

  // Base conversion display
  const validBases = [2, 8, 10, 16];
  let activeBase = Number(localStorage.getItem(`${storageKey}-activeBase`) ?? '10');
  if (!validBases.includes(activeBase)) activeBase = 10;
  let lastIntegerResult = 0;

  if (features.includes('programmer')) {
    updateDigitStates(activeBase);
  }

  function refreshBaseDisplay() {
    updateBaseDisplay(lastIntegerResult, activeBase);
  }

  // Panel switching (main / abc / func keyboards)
  drawer.querySelectorAll<HTMLInputElement>('[data-panel]').forEach((radio) => {
    radio.addEventListener('click', () => {
      const panel = radio.dataset.panel;
      if (panel) {
        showPanel(panel, drawer);
        const baseDisplay = drawer.querySelector<HTMLElement>('#base-display');
        if (baseDisplay) {
          baseDisplay.style.display = panel === 'programmer' ? 'flex' : 'none';
          if (panel === 'programmer') {
            refreshBaseDisplay();
          }
        }
      }
    });
  });

  // Show the initially checked panel
  const panelClassMap: Record<string, string> = {
    scientific: 'main',
    basic: 'basic',
    abc: 'abc',
    func: 'func',
    programmer: 'programmer',
  };
  const checkedRadio = drawer.querySelector<HTMLInputElement>('[data-panel]:checked');
  const initialPanel = checkedRadio?.dataset.panel ?? panelClassMap[features[0]];
  if (initialPanel) {
    showPanel(initialPanel, drawer);
    const baseDisplay = drawer.querySelector<HTMLElement>('#base-display');
    if (baseDisplay) {
      baseDisplay.style.display = initialPanel === 'programmer' ? 'flex' : 'none';
    }
  }

  function updateDigitStates(activeBase: number) {
    const programmerKeyboard = drawer.querySelector<HTMLElement>('#programmer-keyboard');
    if (!programmerKeyboard) return;

    // Hex digits A-F: only enabled in base 16
    programmerKeyboard.querySelectorAll<HTMLButtonElement>('.btn-hex').forEach((btn) => {
      btn.disabled = activeBase !== 16;
    });

    // Numeric digits: disable those >= activeBase
    programmerKeyboard.querySelectorAll<HTMLButtonElement>('.btn-digit').forEach((btn) => {
      const digit = Number(btn.dataset.key);
      if (!Number.isNaN(digit)) {
        btn.disabled = digit >= activeBase;
      }
    });
  }

  drawer.querySelectorAll<HTMLElement>('.base-value').forEach((el) => {
    el.addEventListener('click', () => {
      // Copy the raw value (without label) to clipboard
      const text = el.textContent.replace(/^(HEX|OCT|DEC|BIN):\s*/, '');
      void navigator.clipboard.writeText(text);

      // Switch active base
      const newBase = Number(el.dataset.base);
      if (newBase) {
        activeBase = newBase;
        localStorage.setItem(`${storageKey}-activeBase`, String(activeBase));
        updateDigitStates(activeBase);
        refreshBaseDisplay();
      }
    });
  });

  // Symbolic-numeric transformation
  prepareButton(displayModeSwitch);
  displayModeSwitch.addEventListener('click', () => {
    if (calculatorOutput.dataset.displayMode === 'numeric') {
      calculatorOutput.dataset.displayMode = 'symbolic';
    } else {
      calculatorOutput.dataset.displayMode = 'numeric';
    }
    calculate();
  });

  // Degree-radian transformation
  prepareButton(angleModeSwitch);
  angleModeSwitch.addEventListener('click', () => {
    if (calculatorOutput.dataset.angleMode === 'deg') {
      calculatorOutput.dataset.angleMode = 'rad';
    } else {
      calculatorOutput.dataset.angleMode = 'deg';
    }
    calculate();
  });

  /** Keyboard handling */
  function handleKeyPress(ev: KeyboardEvent) {
    switch (ev.key) {
      case 'Enter':
        calculate(true);
      // falls through
      case 'Tab':
        if (calculatorInputElement.mode === 'latex') {
          calculatorInputElement.mode = 'math';
          ev.preventDefault();
        }
    }
  }
  calculatorInputElement.addEventListener('keydown', (ev) => {
    if (
      shouldAutoInsertAns &&
      calculatorInputElement.value.length === 0 &&
      !ev.ctrlKey &&
      !ev.metaKey
    ) {
      if (autoAnsKeys.has(ev.key)) {
        calculatorInputElement.insert('\\operatorname{ans}');
      }
      if (ev.key.length === 1) {
        shouldAutoInsertAns = false;
      }
    }
    handleKeyPress(ev);
  });

  // Shortcuts
  calculatorInputElement.inlineShortcuts = {
    ...calculatorInputElement.inlineShortcuts,
    ans: '\\operatorname{ans}',
    stdev: '\\operatorname{stdev}([#?])',
    nCr: '\\operatorname{nCr}(#?,#?)',
    nPr: '\\operatorname{nPr}(#?,#?)',
    mean: '\\operatorname{mean}([#?])',
    root: '\\sqrt[#?]{#?}',
    round: '\\operatorname{round}(#?)',
    log: '\\log_{#?}{#?}',
    abs: '|#?|',
    ':=': '\\coloneqq',
    '**': '#@^{(#?)}',
    '^': '#@^{(#?)}',
  };

  function hasError(json: MathJsonExpression): boolean {
    if (!Array.isArray(json)) return false;
    if (json[0] === 'Error') return true;

    for (const item of json.slice(1)) {
      if (hasError(item)) return true;
    }
    return false;
  }

  function radianToDegree(json: MathJsonExpression): MathJsonExpression {
    if (!Array.isArray(json)) {
      return json;
    }
    if (TRIG_FUNCTIONS.has(json[0] as string)) {
      return [json[0], ['Degrees', radianToDegree(json[1])]];
    }
    if (INVERSE_TRIG_FUNCTIONS.has(json[0] as string)) {
      return ['Divide', [json[0], radianToDegree(json[1])], ['Degrees', 1]];
    }
    const [symbol, ...args] = json;
    return [symbol, ...args.map(radianToDegree)];
  }

  /**
   * Prepares a button to maintain focus on the calculator input when clicked.
   * This prevents the input border from blinking when buttons are clicked.
   */
  function prepareButton(button: Element) {
    button.addEventListener('mousedown', (ev) => {
      if (document.activeElement === calculatorInputElement) {
        ev.preventDefault();
      }
    });
  }

  function setupButtonEvents(actions: Record<string, string>) {
    for (const [buttonKey, action] of Object.entries(actions)) {
      drawer.querySelectorAll<HTMLButtonElement>(`[data-key="${buttonKey}"]`).forEach((button) => {
        prepareButton(button);
        button.addEventListener('click', () => {
          if (
            shouldAutoInsertAns &&
            calculatorInputElement.value.length === 0 &&
            autoAnsButtons.has(buttonKey)
          ) {
            if (action.includes('#0')) {
              calculatorInputElement.insert(action.replaceAll('#0', '\\operatorname{ans}'));
            } else {
              calculatorInputElement.insert('\\operatorname{ans}');
              calculatorInputElement.insert(action);
            }
          } else {
            calculatorInputElement.insert(action);
          }
          shouldAutoInsertAns = false;
          calculatorInputElement.focus();
        });
      });
    }
  }

  function addHistoryItem(dataHistoryItem: HistoryItem) {
    const { input, displayed, angleMode } = dataHistoryItem;

    const clone = document.importNode(historyTemplate.content, true);

    const historyItem = ensureElement(clone.querySelector<HTMLElement>('.history-item'));
    historyItem.dataset.input = input;
    historyItem.dataset.angleMode = angleMode;

    // Set input text
    const inputRow = ensureElement(clone.querySelector<HTMLElement>('.history-input'));
    const inputField = ensureElement(
      inputRow.querySelector<MathfieldElement>('.pl-calculator-history-text'),
    );
    inputField.value = input;

    // Set output text
    const outputRow = ensureElement(clone.querySelector<HTMLElement>('.history-output'));
    const outputField = ensureElement(
      outputRow.querySelector<MathfieldElement>('.pl-calculator-history-text'),
    );
    outputField.value = `=${displayed}`;

    // Only show rad/deg badge if expression contains trig functions
    const modeBadge = ensureElement(clone.querySelector<HTMLElement>('.history-mode-badge'));
    const hasTrig = containsTrigFunction(input);
    if (!hasTrig) {
      modeBadge.classList.add('d-none');
    } else {
      updateModeBadge(modeBadge, angleMode);
    }

    const normalizeLatex = (latex: string) => ce.parse(latex).toString();
    const historyOnExport: MathfieldElement['onExport'] = (_mf, latex) => normalizeLatex(latex);
    inputField.onExport = historyOnExport;
    outputField.onExport = historyOnExport;

    // Copy buttons
    const inputCopyBtn = ensureElement(
      clone.querySelector<HTMLElement>('.history-input .history-copy-btn'),
    );
    const outputCopyBtn = ensureElement(
      clone.querySelector<HTMLElement>('.history-output .history-copy-btn'),
    );
    inputCopyBtn.addEventListener('click', () => {
      window.bootstrap.Tooltip.getInstance(inputCopyBtn)?.hide();
      void navigator.clipboard.writeText(normalizeLatex(input));
    });
    outputCopyBtn.addEventListener('click', () => {
      window.bootstrap.Tooltip.getInstance(outputCopyBtn)?.hide();
      void navigator.clipboard.writeText(normalizeLatex(outputField.value.replace(/^=/, '')));
    });

    // Insert buttons
    const inputInsertBtn = ensureElement(
      clone.querySelector<HTMLElement>('.history-input .history-insert-btn'),
    );
    const outputInsertBtn = ensureElement(
      clone.querySelector<HTMLElement>('.history-output .history-insert-btn'),
    );
    inputInsertBtn.addEventListener('click', () => {
      window.bootstrap.Tooltip.getInstance(inputInsertBtn)?.hide();
      calculatorInputElement.insert(input);
      calculatorInputElement.dispatchEvent(new CustomEvent('input'));
      calculatorInputElement.focus();
    });
    outputInsertBtn.addEventListener('click', () => {
      window.bootstrap.Tooltip.getInstance(outputInsertBtn)?.hide();
      calculatorInputElement.insert(outputField.value.replace(/^=/, ''));
      calculatorInputElement.dispatchEvent(new CustomEvent('input'));
      calculatorInputElement.focus();
    });

    // Deg/rad mode badge
    modeBadge.addEventListener('click', () => {
      // Hide tooltip before changing text, otherwise it stays open
      window.bootstrap.Tooltip.getInstance(modeBadge)?.hide();
      const newMode = historyItem.dataset.angleMode === 'deg' ? 'rad' : 'deg';
      historyItem.dataset.angleMode = newMode;
      updateModeBadge(modeBadge, newMode);
      reevaluateHistoryItem(historyItem);

      // Persist the angle mode change to localStorage
      const items = Array.from(historyPanel.querySelectorAll<HTMLElement>('.history-item'));
      const domIndex = items.indexOf(historyItem);
      const data = getCalculatorData(storageKey);
      const storageIndex = data.history.length - 1 - domIndex;
      if (storageIndex >= 0 && storageIndex < data.history.length) {
        data.history[storageIndex].angleMode = newMode;
        setCalculatorData(storageKey, data);
      }
    });

    historyPanel.insertBefore(clone, historyPanel.firstChild);
    historyPanel.scrollTop = 0;
    clearHistoryBtn.classList.remove('d-none');
  }
}

function showPanel(panelClass: string, container: HTMLElement) {
  const panels = container.querySelectorAll<HTMLElement>('.keyboard');
  panels.forEach((panel) => (panel.style.display = 'none'));

  const panelToShow = container.querySelectorAll<HTMLElement>(`.keyboard.${panelClass}`);
  panelToShow.forEach((panel) => (panel.style.display = 'flex'));
}

function initColumnNavigation(container: HTMLElement) {
  setupKeyboardNav('main-keyboard', 'show-functions');
  setupKeyboardNav('func-keyboard', 'show-trig');
  setupKeyboardNav('programmer-keyboard', 'show-bitwise');

  function setupKeyboardNav(keyboardId: string, toggleClass: string) {
    const keyboard = container.querySelector<HTMLElement>(`#${keyboardId}`);
    if (!keyboard) return;

    keyboard.querySelectorAll('.col-nav').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        keyboard.classList.toggle(toggleClass);
      });
    });
  }
}

function initDrawerUI(
  drawer: HTMLElement,
  fab: HTMLElement,
  fabClose: HTMLElement | null,
  storageKey: string,
) {
  function setIsOpen(value: boolean) {
    const data = getCalculatorData(storageKey);
    data.isOpen = value;
    setCalculatorData(storageKey, data);
  }

  function openDrawer() {
    fab.classList.remove('visible');
    drawer.classList.add('open');
    setIsOpen(true);
    drawer.querySelector<MathfieldElement>('#calculator-input')?.focus();
  }

  function collapseDrawer() {
    drawer.classList.remove('open');
    fab.classList.add('visible');
    setIsOpen(false);
  }

  function dismissCalculator() {
    drawer.classList.remove('open');
    fab.classList.remove('visible');
    setIsOpen(false);
  }

  fab.addEventListener('click', (ev) => {
    if (fabClose?.contains(ev.target as Node)) return;
    openDrawer();
  });

  if (fabClose) {
    fabClose.addEventListener('click', (ev) => {
      ev.stopPropagation();
      dismissCalculator();
    });
  }

  // Left-edge resize handle
  const resizeHandle = drawer.querySelector<HTMLElement>('#calculatorResizeHandle');
  if (resizeHandle) {
    let startX = 0;
    let startWidth = 0;

    function onPointerMove(ev: PointerEvent) {
      const delta = startX - ev.clientX;
      drawer.style.width = `${Math.max(460, startWidth + delta)}px`;
    }

    function onPointerUp() {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
    }

    resizeHandle.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      startX = ev.clientX;
      startWidth = drawer.offsetWidth;
      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
    });
  }

  // Clicking the header button toggles open/collapse
  const header = drawer.querySelector('.calculator-drawer-header');
  if (header) {
    header.addEventListener('click', () => {
      if (drawer.classList.contains('open')) {
        collapseDrawer();
      } else {
        openDrawer();
      }
    });
  }
}

export function registerCustomFunctions(ce: InstanceType<typeof ComputeEngine>) {
  function computePermComb(n: Expression, r: Expression, combination: boolean) {
    const nVal = n.re;
    const rVal = r.re;
    if (Number.isNaN(nVal) || Number.isNaN(rVal)) return ce.error('Invalid input');
    if (rVal > nVal) return ce.number(0);
    const nFact = ce.expr(['Factorial', n.json]).evaluate();
    const nrFact = ce.expr(['Factorial', n.sub(r).json]).evaluate();
    if (combination) {
      const rFact = ce.expr(['Factorial', r.json]).evaluate();
      return nFact.div(rFact.mul(nrFact));
    }
    return nFact.div(nrFact);
  }

  ce.declare('nCr', {
    signature: '(n: number, r: number) -> number',
    evaluate([n, r]) {
      return computePermComb(n, r, true);
    },
  });

  ce.declare('nPr', {
    signature: '(n: number, r: number) -> number',
    evaluate([n, r]) {
      return computePermComb(n, r, false);
    },
  });

  function computeStdev(list: Expression, population: boolean) {
    if (!isTensor(list)) {
      return ce.error('Input must be a list');
    }
    if (list.shape.length !== 1) {
      return ce.error('Input must be a 1-dimensional list');
    }
    const n = list.shape[0];
    const xs = Array.from(list.each());
    const mean = xs.reduce((a, b) => a.add(b)).div(n);
    const divisor = population ? n : n - 1;
    const variance = xs.reduce((sum, x) => sum.add(x.sub(mean).pow(2)), ce.number(0)).div(divisor);
    return variance.sqrt();
  }

  ce.declare('stdev', {
    signature: '(xs: list) -> number',
    evaluate([list]) {
      return computeStdev(list, false);
    },
  });

  // stdevp is only accessible via the button UI, not as an inline shortcut,
  // because typing "stdev" triggers the stdev shortcut before "p" can be typed
  ce.declare('stdevp', {
    signature: '(xs: list) -> number',
    evaluate([list]) {
      return computeStdev(list, true);
    },
  });

  // Bitwise operations (JavaScript bitwise operators work on 32-bit integers)
  // Override built-in logical operators with bitwise implementations
  // CE's \operatorname{and}, \operatorname{or}, \veebar, \lnot, \barwedge
  // parse to And, Or, Xor, Not, Nand respectively
  ce.declare('And', {
    signature: '(a: number, b: number) -> number',
    evaluate([a, b]) {
      return ce.number(a.re & b.re);
    },
  });

  ce.declare('Or', {
    signature: '(a: number, b: number) -> number',
    evaluate([a, b]) {
      return ce.number(a.re | b.re);
    },
  });

  ce.declare('Xor', {
    signature: '(a: number, b: number) -> number',
    evaluate([a, b]) {
      return ce.number(a.re ^ b.re);
    },
  });

  ce.declare('Not', {
    signature: '(a: number) -> number',
    evaluate([a]) {
      return ce.number(~a.re);
    },
  });

  ce.declare('Nand', {
    signature: '(a: number, b: number) -> number',
    evaluate([a, b]) {
      return ce.number(~(a.re & b.re));
    },
  });

  // Nor, Lsh, Rsh don't have built-in infix triggers — used as functions
  ce.declare('Nor', {
    signature: '(a: number, b: number) -> number',
    evaluate([a, b]) {
      return ce.number(~(a.re | b.re));
    },
  });

  ce.declare('Lsh', {
    signature: '(a: number, b: number) -> number',
    evaluate([a, b]) {
      return ce.number(a.re << b.re);
    },
  });

  ce.declare('Rsh', {
    signature: '(a: number, b: number) -> number',
    evaluate([a, b]) {
      return ce.number(a.re >> b.re);
    },
  });
}

export function containsTrigFunction(input: string): boolean {
  return /sin|cos|tan|cot|sec|csc/i.test(input);
}

function updateModeBadge(badge: HTMLElement, mode: AngleMode) {
  badge.textContent = mode;
  badge.classList.toggle('color-blue1', mode === 'rad');
  badge.classList.toggle('color-orange1', mode === 'deg');
}

function ensureElement<E extends Element>(element: E | null): E {
  if (!element) {
    throw new Error('Element is required but not found in the DOM.');
  }
  return element;
}

onDocumentReady(() => {
  const drawer = document.getElementById('calculatorDrawer');
  const fab = document.getElementById('calculatorFab');
  const fabClose = document.getElementById('calculatorFabClose');
  if (!drawer || !fab) return;

  const storageKey = drawer.dataset.storageKey ?? 'pl-calculator';
  let initialized = false;

  const initIfNeeded = () => {
    if (!initialized) {
      try {
        initCalculator(storageKey, { drawer, fab, fabClose });
        initialized = true;
      } catch (e) {
        console.error('Failed to initialize calculator:', e);
      }
    }
  };

  const toggleBtn = document.getElementById('calculatorDrawerToggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      initIfNeeded();
      fab.click();
    });
  }

  const wasOpen = getCalculatorData(storageKey).isOpen === true;
  if (wasOpen) {
    initIfNeeded();
    fab.classList.remove('visible');
    drawer.classList.add('no-transition', 'open');
    // Remove the no-transition class after the browser has painted the open state
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        drawer.classList.remove('no-transition');
      });
    });
  }
});
