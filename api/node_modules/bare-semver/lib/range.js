const constants = require('./constants')
const errors = require('./errors')
const Version = require('./version')
const Comparator = require('./comparator')

class Range {
  constructor(comparators = []) {
    this.comparators = comparators
  }

  test(version) {
    for (const set of this.comparators) {
      let matches = true

      for (const comparator of set) {
        if (comparator.test(version)) continue
        matches = false
        break
      }

      if (!matches) continue

      // Following npm, a version with prerelease tags may only satisfy a
      // comparator set if at least one comparator in the set targets the same
      // [major, minor, patch] tuple and itself carries prerelease tags. This
      // keeps a range like '>=1.2.3-beta.2 <1.3.0-0' from matching
      // '1.2.4-alpha', whose prerelease was never opted into.
      if (version.prerelease.length && !allows(set, version)) continue

      return true
    }

    return false
  }

  toString() {
    let result = ''
    let first = true

    for (const set of this.comparators) {
      if (first) first = false
      else result += ' || '

      result += set.join(' ')
    }

    return result
  }
}

module.exports = exports = Range

exports.parse = function parse(input, state = { position: 0, partial: false }) {
  let i = state.position
  let c

  const unexpected = (expected) => {
    let msg

    if (i >= input.length) {
      msg = `Unexpected end of input in '${input}'`
    } else {
      msg = `Unexpected token '${input[i]}' in '${input}' at position ${i}`
    }

    if (expected) msg += `, ${expected}`

    throw errors.INVALID_VERSION(msg, unexpected)
  }

  const comparators = []

  while (i < input.length) {
    const set = []

    while (i < input.length) {
      c = input[i]

      let operator = constants.EQ
      let caret = false
      let tilde = false

      if (c === '<') {
        operator = constants.LT
        c = input[++i]

        if (c === '=') {
          operator = constants.LTE
          c = input[++i]
        }
      } else if (c === '>') {
        operator = constants.GT
        c = input[++i]

        if (c === '=') {
          operator = constants.GTE
          c = input[++i]
        }
      } else if (c === '=') {
        c = input[++i]
      } else if (c === '^') {
        caret = true
        c = input[++i]
      } else if (c === '~') {
        tilde = true
        c = input[++i]

        // Accept the legacy `~>` spelling as an alias for `~`.
        if (c === '>') c = input[++i]
      }

      while (c === ' ') c = input[++i]

      const state = { position: i, partial: true, range: true }

      const lower = Version.parse(input, state)

      const precision = state.precision

      c = input[(i = state.position)]

      while (c === ' ') c = input[++i]

      // A hyphen range, e.g. '1.2.3 - 2.3.4', is only valid as a bare version
      // pair without an operator or shorthand prefix.
      if (c === '-' && input[i + 1] === ' ' && operator === constants.EQ && !caret && !tilde) {
        c = input[++i]

        while (c === ' ') c = input[++i]

        state.position = i

        const high = Version.parse(input, state)

        c = input[(i = state.position)]

        set.push(new Comparator(constants.GTE, lower))

        if (state.precision === 3) {
          set.push(new Comparator(constants.LTE, high))
        } else if (state.precision === 2) {
          set.push(upper(high.major, high.minor + 1, 0))
        } else if (state.precision === 1) {
          set.push(upper(high.major + 1, 0, 0))
        }

        while (c === ' ') c = input[++i]
      } else {
        if (caret) {
          for (const comparator of expandCaret(lower, precision)) set.push(comparator)
        } else if (tilde) {
          for (const comparator of expandTilde(lower, precision)) set.push(comparator)
        } else if (operator === constants.EQ) {
          for (const comparator of expandPartial(lower, precision)) set.push(comparator)
        } else {
          set.push(new Comparator(operator, lower))
        }
      }

      if (c === '|' && input[i + 1] === '|') {
        c = input[(i += 2)]

        while (c === ' ') c = input[++i]

        break
      }

      if (c && c !== '<' && c !== '>' && c !== '^' && c !== '~' && c !== '=') {
        unexpected("expected '||', '<', '>', '^', '~', or '='")
      }
    }

    if (set.length) comparators.push(set)
  }

  if (i < input.length && state.partial === false) {
    unexpected('expected end of input')
  }

  state.position = i

  return new Range(comparators)
}

// Determines whether a comparator set opts into prerelease versions for the
// given version's [major, minor, patch] tuple, i.e. whether any comparator
// targets that exact tuple with prerelease tags of its own.
function allows(set, version) {
  for (const comparator of set) {
    const target = comparator.version

    if (
      target.prerelease.length &&
      target.major === version.major &&
      target.minor === version.minor &&
      target.patch === version.patch
    ) {
      return true
    }
  }

  return false
}

// Constructs a `< major.minor.patch-0` comparator. The `-0` prerelease sentinel
// is the lowest possible prerelease, so it excludes every prerelease of the
// upper bound, matching the desugaring used by node-semver.
function upper(major, minor, patch) {
  return new Comparator(constants.LT, new Version(major, minor, patch, { prerelease: ['0'] }))
}

// Expands a partial version or X-range into a set of comparators, e.g. '1.2'
// and '1.2.x' both become '>=1.2.0 <1.3.0-0'.
function expandPartial(version, precision) {
  if (precision === 0) return [new Comparator(constants.GTE, new Version(0, 0, 0))]
  if (precision === 3) return [new Comparator(constants.EQ, version)]

  const set = [new Comparator(constants.GTE, version)]

  if (precision === 1) set.push(upper(version.major + 1, 0, 0))
  else set.push(upper(version.major, version.minor + 1, 0))

  return set
}

// Expands a caret range, allowing changes that do not modify the left-most
// non-zero component, e.g. '^1.2.3' becomes '>=1.2.3 <2.0.0-0'.
function expandCaret(version, precision) {
  if (precision === 0) return [new Comparator(constants.GTE, new Version(0, 0, 0))]

  const { major, minor, patch } = version
  const set = [new Comparator(constants.GTE, version)]

  if (major !== 0) set.push(upper(major + 1, 0, 0))
  else if (precision === 1) set.push(upper(1, 0, 0))
  else if (minor !== 0) set.push(upper(0, minor + 1, 0))
  else if (precision === 2) set.push(upper(0, 1, 0))
  else set.push(upper(0, 0, patch + 1))

  return set
}

// Expands a tilde range, allowing patch-level changes if a minor version is
// specified and minor-level changes if not, e.g. '~1.2.3' becomes
// '>=1.2.3 <1.3.0-0' and '~1' becomes '>=1.0.0 <2.0.0-0'.
function expandTilde(version, precision) {
  if (precision === 0) return [new Comparator(constants.GTE, new Version(0, 0, 0))]

  const { major, minor } = version
  const set = [new Comparator(constants.GTE, version)]

  if (precision === 1) set.push(upper(major + 1, 0, 0))
  else set.push(upper(major, minor + 1, 0))

  return set
}
