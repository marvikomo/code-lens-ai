#include <stdio.h>

struct Shape {
    int n;
};

int helper(int a) {
    return a;
}

void draw(struct Shape *s) {
    helper(s->n);
    printf("%d", s->n);
}
