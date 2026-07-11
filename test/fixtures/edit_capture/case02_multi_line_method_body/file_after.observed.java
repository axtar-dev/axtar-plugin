package com.example.util;

public class Calculator {
    public int add(int a, int b) {
        // Defensive overflow check.
        if ((b > 0 && a > Integer.MAX_VALUE - b) ||
            (b < 0 && a < Integer.MIN_VALUE - b)) {
            throw new ArithmeticException("integer overflow");
        }
        return a + b;
    }

    public int multiply(int a, int b) {
        return a * b;
    }
}
