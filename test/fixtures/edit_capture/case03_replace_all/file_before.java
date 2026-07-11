package com.example;

public class Renamer {
    private String oldName;

    public String getOldName() {
        return oldName;
    }

    public void setOldName(String oldName) {
        this.oldName = oldName;
    }

    public void describe() {
        System.out.println("oldName=" + oldName);
        System.out.println("My oldName is: " + oldName);
    }
}
