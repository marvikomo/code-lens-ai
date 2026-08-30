package netext

// Dial is capitalised, so other packages may import it.
func Dial() int { return prepare() }

// prepare is lowercase — package-private, not importable.
func prepare() int { return 1 }
