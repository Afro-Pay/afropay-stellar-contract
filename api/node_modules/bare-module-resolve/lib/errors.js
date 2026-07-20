module.exports = class ModuleResolveError extends Error {
  constructor(msg, fn = ModuleResolveError, code = fn.name) {
    super(`${code}: ${msg}`)

    this.code = code

    if (Error.captureStackTrace) Error.captureStackTrace(this, fn)
  }

  get name() {
    return 'ModuleResolveError'
  }

  static INVALID_MODULE_SPECIFIER(msg) {
    return new ModuleResolveError(msg, ModuleResolveError.INVALID_MODULE_SPECIFIER)
  }

  static INVALID_PACKAGE_TARGET(msg) {
    return new ModuleResolveError(msg, ModuleResolveError.INVALID_PACKAGE_TARGET)
  }

  static INVALID_PACKAGE_CONFIGURATION(msg) {
    return new ModuleResolveError(msg, ModuleResolveError.INVALID_PACKAGE_CONFIGURATION)
  }

  static PACKAGE_PATH_NOT_EXPORTED(msg) {
    return new ModuleResolveError(msg, ModuleResolveError.PACKAGE_PATH_NOT_EXPORTED)
  }

  static PACKAGE_IMPORT_NOT_DEFINED(msg) {
    return new ModuleResolveError(msg, ModuleResolveError.PACKAGE_IMPORT_NOT_DEFINED)
  }

  static UNSUPPORTED_ENGINE(msg) {
    return new ModuleResolveError(msg, ModuleResolveError.UNSUPPORTED_ENGINE)
  }
}
