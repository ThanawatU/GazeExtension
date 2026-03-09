W = 6.3  
F = 923   

def calculate_distance(landmarks):

    landmarks = landmarks[0]
    p1 = landmarks[145]
    p2 = landmarks[374]
    
    w = ((p2.x - p1.x)**2 + (p2.y - p1.y)**2) ** 0.5
    
    if w == 0:
        return None
    return round((W * F) / w, 2)