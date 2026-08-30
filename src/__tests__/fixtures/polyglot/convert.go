package shapes

// A user function whose name collides with a predeclared type. On k6 this
// exact shape absorbed thousands of conversion "calls".
func string(v int) int {
	return v
}

type wrapper struct{ n int }

func (w *wrapper) error() string2 {
	return nil
}

type string2 interface{}

func convert(n int64, p uintptr) {
	_ = int(n)
	_ = uint32(n)
	_ = float64(n)
	_ = uintptr(p)
	w := &wrapper{}
	// A receiver call that shares a predeclared type's name must survive.
	w.error()
}
