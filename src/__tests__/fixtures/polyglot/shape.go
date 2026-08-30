package shapes

import "fmt"

type Shape struct {
	N int
}

type Drawer interface {
	Draw()
}

func (s *Shape) Draw() {
	fmt.Println(s.N)
	helper()
}

func helper() {
	items := make([]int, 0)
	_ = append(items, 1)
}
