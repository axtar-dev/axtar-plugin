package com.example;

public class Renamer {
    private String newName;

    public String getOldName() {
        return newName;
    }

    public void setOldName(String newName) {
        this.newName = newName;
    }

    public void describe() {
        System.out.println("newName=" + newName);
        System.out.println("My newName is: " + newName);
    }
}
